'use strict';
// scamp/lib/util/serviceMgr.js

var soa        = require('../index.js'),
    util       = require('util'),
    EventEmitter = require('events').EventEmitter,
    serviceCls = soa.module('handle/service');

var timeoutMultiplier = 2.1;

exports.create = function(params){ return new Manager(params) }

function Registration(svc) {
    var me = this;
    EventEmitter.call(me);

    me._failures = [];
    me._reactivateTime = -Infinity;
}
util.inherits(Registration, EventEmitter);

Registration.prototype.refresh = function () {
    if (this.timer) clearTimeout( this.timer );

    var me = this;
    me.timer = setTimeout( function () { me.emit('timeout'); }, parseInt( me.service.sendInterval ) * timeoutMultiplier );
};

Registration.prototype.connectFailed = function () {
    var now = Date.now();

    while (this._failures.length && this._failures[0] < (now - 86400 * 1000)) this._failures.shift();
    this._failures.push(now);

    var minutes = Math.min(60, this._failures.length);
    this._reactivateTime = now + 60*1000 * minutes;
    soa.error('Marking',this.service.workerIdent,'"failed" for',minutes,'minutes');
};

Registration.prototype.isFailed = function () {
    return Date.now() < this._reactivateTime;
};

// Yo, I AM Your manager, B!
function Manager( params ){
    var me = this;
    EventEmitter.call(this);

    me._sector = params.sector || 'main';
    me._registry = {};
    me._cached = {};
    me._seenTimestamps = {};

    me._actionIndex   = {};
}
util.inherits(Manager, EventEmitter);

Manager.prototype.registerService = function( text, fingerprint ){
    var me   = this;
    var key = fingerprint + text; // note: fingerprint is fixed length 20*3-1
    if (me._cached[key]) {
        me._cached[key].refresh(); // delay timeout
        return; // no reindexing or reparsing
    }

    var svinfo = serviceCls.create( text, fingerprint );
    if (svinfo.badVersion) return; // not for us
    if (svinfo.timestamp < me._seenTimestamps[svinfo.workerIdent]) throw "timestamp "+svinfo.timestamp+" is not the most recent for "+svinfo.workerIdent;
    me._seenTimestamps[svinfo.workerIdent] = svinfo.timestamp;

    var reg = me._registry[ svinfo.workerIdent ];

    if (reg) {
        this._index(reg, false);
        reg.service = svinfo;
        svinfo.registration = reg;
        reg.refresh();
        this._index(reg, true);
    } else {
        reg = new Registration();
        reg.service = svinfo;
        svinfo.registration = reg;
        reg.refresh();
        this._index(reg, true);

        reg.on('timeout', function(){ me._index(reg, false); me.emit('changed'); });
    }
    this.emit('changed');
};

Manager.prototype._baseIndex = function (index, key, service, info) {
    var ref, name;

    key = key.toLowerCase();
    //console.log('+', (info ? 'Reg' : 'Dereg') + 'istrating', key);
    if (info) {
        ref = index[key] = index[key] || { };
        ref[ service ] = info;
    } else {
        ref = index[key];
        if (!ref) return;
        delete ref[service];
        for (name in ref) { if (ref.hasOwnProperty(name)) return; }
        // if there is nothing left in ref, remove the key
        delete index[key];
    }
};

var alias_tags = ['create', 'read', 'update', 'destroy'];

Manager.prototype._index = function (reg, insert) {
    var me   = this,
        service = reg.service,
        name = service.workerIdent;

    me._registry[ name ] = insert && reg;
    //console.log((insert ? 'Reg' : 'Dereg') + 'istrations for', name);

    service.actions.forEach(function (info) {
        if (info.sector !== me._sector) return;
        var aname   = info.namespace + '.' + info.name;
        var block   = [ name, reg, aname, info.version, info.flags, info.envelopes ];

        if (insert && !service.authorized(me._sector, aname))
            return;

        me._baseIndex(me._actionIndex, aname + '.v' + info.version, name, insert && block);

        block[4].forEach(function (crud_tag) {
            if (alias_tags.indexOf(crud_tag) >= 0)
                me._baseIndex(me._actionIndex, info.namespace + '._' + crud_tag + '.v' + info.version, name, insert && block);
        });
    });
};

Manager.prototype.findAction = function( action, envelope, version, ident) {
    var me   = this;

    if( !action   ) throw "action is required";
    if( !envelope ) throw "protocol is required";
    version = Number(version) || 1;

    var list = me._actionIndex[ String(action).toLowerCase() + '.v' + version ]; // XXX name mangling
    if(!list) return null;


    var filtered = [],
        failing = [],
        item;

    // this is a little bit weak sauce
    Object.keys(list).forEach(function (k) {
        if (list[k][5].indexOf(envelope) >= 0 && (!ident || ident == list[k][1].service.workerIdent)) {
            (list[k][1].isFailed() ? failing : filtered).push(list[k]);
        }
    });

    if( filtered.length == 0 ) filtered = failing;
    if( filtered.length == 0 ) return null;

    item = filtered[ Math.floor( Math.random() * filtered.length ) ];

    var timeout = soa.config().val('rpc.timeout', 75);
    item[4].forEach( function (f) { if (/^t\d+$/.test(f)) timeout = +f.substring(1); } );
    return {
        action: item[2],
        version: item[3],
        flags: item[4],
        address: item[1].service.address,
        fingerprint: item[1].service.fingerprint,
        service: item[1].service,
        timeout: timeout * 1000,
    };
};

Manager.prototype.listActions = function () {
    var me = this,
        actions = [];

    Object.keys(this._actionIndex).sort().forEach(function (key) {
        var name, block;
        for (name in me._actionIndex[key]) { block = me._actionIndex[key][name]; break; }

        actions.push([block[2], block[3]]);
    });

    return actions;
};
