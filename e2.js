(function(global) {
    'use strict';
    var asyncCall = (function() {
        var list = [];
        var addFunction = function(fn) {
            return list.push(fn) - 1;
        };
        var callList = function() {
            var store = list;
            var length = store.length;
            var i = 0;
            list = [];

            while (i < length) {
                store[i++]();
            }
        };

        // ie10, nodejs >= 0.10
        if (typeof setImmediate === 'function') {
            return function(fn) {
                addFunction(fn) || setImmediate(callList);
            };
        }

        // nodejs < 0.10
        if (typeof process === 'object' && process.nextTick) {
            return function(fn) {
                addFunction(fn) || process.nextTick(callList);
            };
        }

        // Async postMessage checking from https://github.com/YuzuJS/setImmediate
        // The test against `importScripts` prevents this implementation from being installed inside a web worker,
        // where `global.postMessage` means something completely different and can't be used for this purpose.
        if (global.postMessage) {
            var postMessageIsAsynchronous = true;
            var oldOnMessage = global.onmessage;
            global.onmessage = function() {
                postMessageIsAsynchronous = false;
            };
            global.postMessage('', '*');
            global.onmessage = oldOnMessage;

            if (postMessageIsAsynchronous) {
                var messageFlag = '__e2__' + new Date().getTime();
                var processMessage = function(e) {
                    if (e.data !== messageFlag) {
                        return;
                    }
                    // check stopPropagation access
                    // https://developer.mozilla.org/ru/docs/Web/API/event/stopPropagation
                    e.stopPropagation && e.stopPropagation();

                    callList();
                };

                if (global.addEventListener) {
                    global.addEventListener('message', processMessage, true);
                } else {
                    global.attachEvent('onmessage', processMessage);
                }

                return function(fn) {
                    addFunction(fn) || global.postMessage(messageFlag, '*');
                };
            }
        }

        return function(fn) {
            addFunction(fn) || setTimeout(callList, 0);
        };

    })();

    function E2() {}

    function addCallback(event, callback, callbacksList) {
        if (!callbacksList[event]) {
            callbacksList[event] = [];
        }

        callbacksList[event].push(callback);
    }

    function callCallbacks(event, list, data, scope) {
        if (!list[event]) {
            return;
        }

        list[event].forEach(function(callback) {
            callback.call(scope, data)
        })
    }

    function removeCallback(callback, list) {
        var index = list.indexOf(callback);
        if (index !== -1) {
            list.splice(index, 1);
        }
    }

    function remove(callbacksList, event, callback) {
        if (callbacksList[event]) {
            if (callback) {
                removeCallback(callback, callbacksList[event]);
            } else {
                callbacksList[event] = [];
            }
        }
    }

    E2.prototype.on = function(event, callback, options) {
        if (!this.__e2__) {
            this.__e2__ = {
                callbacksOnce: {},
                callbacks: {}
            };
        }
        var e2 = this.__e2__;

        /**
         * e2.on(['event1', 'event2'], eventHandler [, options])
         */
        if (event && Array.isArray(event)) {
            event.forEach(function(item) {
                this.on(item, callback, options);
            }, this);

            return this;
        }

        /**
         * e2.on({eventName: eventHandler}[, {once: true}]);
         */
        if (event && typeof event === 'object') {
            options = callback;

            Object.keys(event).forEach(function(key) {
                this.on(key, event[key], options);
            }, this);

            return this;
        }

        if (typeof event !== 'string') {
            throw new TypeError('e2.on: Invalid event type');
        }

        if (options && options.once) {
            addCallback(event, callback, e2.callbacksOnce);
        } else {
            addCallback(event, callback, e2.callbacks);
        }

        return this;
    };

    E2.prototype.once = function(event, callback) {
        return this.on(event, callback, {once: true});
    };

    E2.prototype.off = function(event, callback) {
        if (!this.__e2__) {
            return this;
        }

        /**
         * e2.off(['event1', 'event2'][, eventHandler])
         */
        if (event && Array.isArray(event)) {
            event.forEach(function(item) {
                this.off(item, callback);
            }, this);

            return this;
        }

        /**
         * e2.off({eventName: eventHandler});
         */
        if (event && typeof event === 'object') {
            Object.keys(event).forEach(function(key) {
                this.off(key, event[key]);
            }, this);

            return this;
        }

        if (!event || typeof event !== 'string') {
            throw new TypeError('e2.off: Invalid event type');
        }

        var e2 = this.__e2__;
        remove(e2.callbacks, event, callback);
        remove(e2.callbacksOnce, event, callback);

        return this;
    };

    E2.prototype.listeners = function(event) {
        if (!event || typeof event !== 'string') {
            throw new TypeError('e2.listeners: Invalid event type');
        }

        if (!this.__e2__) {
            return [];
        }

        return [].concat(this.__e2__.callbacks[event] || [])
                 .concat(this.__e2__.callbacksOnce[event] || [])
                 .slice(0);
    };

    E2.prototype.emit = function(event, data, isAsync) {
        if (!this.__e2__) {
            return this;
        }

        /**
         * e2.emit(['event1', 'event2'][, eventData, isAsync])
         */
        if (event && Array.isArray(event)) {
            event.forEach(function(item) {
                this.emit(item, data, isAsync);
            }, this);

            return;
        }

        if (typeof event !== 'string') {
            throw new TypeError('e2.emit: Invalid event type');
        }

        var eventArgs = {
            type: event,
            target: this
        };

        if (data) {
            eventArgs.data = data;
        }

        var e2 = this.__e2__;
        var scope = this;

        var emitEvent = function() {
            callCallbacks(event, e2.callbacks, eventArgs, scope);
            callCallbacks(event, e2.callbacksOnce, eventArgs, scope);
            remove(e2.callbacksOnce, event);
        };

        isAsync ? asyncCall(emitEvent) : emitEvent();

        return this;
    };

    /**
     * async proxy for emit function
     * @param event
     * @param data
     */
    E2.prototype.emitAsync = function(event, data) {
        return this.emit(event, data, true);
    };

    (function(E2) {
        if (typeof define === 'function' && define.amd) {
            // AMD.
            define(E2);
        } else if (typeof exports === 'object') {
            // CommonJS
            module.exports = E2;
        } else {
            // Global scope
            global.E2 = E2;
        }
    })(E2);

})(this);
