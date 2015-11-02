var assert = require('assert');

var E2 = require('../e2');

var event = 'dummy';
var anotherEvent = 'another-dummy';
var eventsArray = [event, anotherEvent];

var dummyFunction = function() {
    assert.ok(true);
};

var fail = function() {
    assert.fail();
};

describe('e2 events', function() {
    describe('e2.on', function () {
        it('must assign function to event name', function (done) {
            var e2 = new E2();
            e2.on(event, done);

            e2.__e2__.callbacks[event][0]();
        });

        it('must call function when event emit', function (done) {
            var e2 = new E2();
            e2.on(event, function() {
                done();
            });
            e2.emit(event);
        });

        it('must not call function if event was triggered early', function (done) {
            var e2 = new E2();
            e2.emit(event);

            e2.on(event, function() {
                assert.fail('called', 'not called');
            });

            setTimeout(done, 0);
        });

        it('must assign callback function to all events in array', function() {
            var e2 = new E2();
            e2.on(eventsArray, dummyFunction);

            e2.emit(eventsArray);
        });

        it('must assign callback function if first argument is object', function() {
            var e2 = new E2();
            e2.on({
                dummy: dummyFunction,
                another: dummyFunction
            });

            e2.emit(['dummy', 'another']);
        });

        it('must throw error if first argument isn\'t array or object', function() {
            var e2 = new E2();
            try {
                e2.on(123, dummyFunction);
            } catch (e) {
                assert.ok(e instanceof TypeError);
            }
        });

        it('must chain methods', function() {
            var e2 = new E2();
            e2.on(event, dummyFunction).on(anotherEvent, dummyFunction).emit(eventsArray);
        });

        it('must call function only one time, if third argument is {once: true}', function() {
            var e2 = new E2();
            var times = 0;
            e2.on(event, function() {
                assert.ok(!times++);
            }, {once: true})
                .emit(event)
                .emit(event);
        });
    });

    describe('e2.once', function() {
        it('must assign function to event name', function () {
            var e2 = new E2();
            e2.once(event, dummyFunction);

            e2.__e2__.callbacksOnce[event][0]();
        });

        it('must call function when event emit', function () {
            var e2 = new E2();
            e2.once(event, dummyFunction)
              .emit(event);
        });


        it('must assign callback function to all events in array', function() {
            var e2 = new E2();
            e2.once(eventsArray, dummyFunction)
              .emit(eventsArray);
        });

        it('must call function only one time', function() {
            var e2 = new E2();
            var times = 0;
            e2.once(event, function() {
                assert.ok(!times++);
            }).emit(event)
              .emit(event);
        });

        it('must chain methods', function() {
            var e2 = new E2();
            e2.once(event, dummyFunction).once(anotherEvent, dummyFunction).emit(eventsArray);
        });

        it('must assign callback function if first argument is object', function() {
            var e2 = new E2();
            e2.once({
                dummy: dummyFunction,
                another: dummyFunction
            }).emit(['dummy', 'another']);
        });
    });

    describe('e2.listeners', function() {
        it('must return callbacks', function() {
            var e2 = new E2();
            e2.on(event, dummyFunction).listeners(event)[0]();
        });

        it('must return callbacksOnce', function() {
            var e2 = new E2();
            e2.once(event, dummyFunction).listeners(event)[0]();
        });

        it('must concate callbacks and callbacksOnce', function() {
            var e2 = new E2();
            var events = e2.on(event, dummyFunction).once(event, dummyFunction).listeners(event);
            events.forEach(function(item) {
                item();
            });
        });

        it('must return functions whose assign to event name', function() {
            var e2 = new E2();
            var events = e2.on(event, dummyFunction).once(event, dummyFunction).on(anotherEvent, fail).listeners(event);
            events.forEach(function(item) {
                item();
            });
        });
    });

    describe('e2.emit', function() {
        it('must call callbacks by event name', function() {
            var e2 = new E2();

            e2.on(event, dummyFunction).emit(event);
        });

        it('must call callbacks for each event in event array', function() {
            var e2 = new E2();

            e2.on(eventsArray, dummyFunction).emit(eventsArray);
        });

        it('must not call callback if first methid was emit', function() {
            var e2 = new E2();

            e2.emit(event).on(event, fail);
        });

        it('must call callback async if third argument is true', function() {
            var e2 = new E2();

            e2.emit(event, null, true).on(event, dummyFunction);
        });

        it('must pass data to callback', function() {
            var e2 = new E2();
            var dummy = {dummy: true};

            e2.on(event, function(data) {
                assert.equal(data.data, dummy)
            }).emit(event, dummy);
        });

        it('must call callbacks with object {data:..., target:..., type:...}', function() {
            var e2 = new E2();
            var dummy = {dummy: true};

            e2.on(event, function(data) {
                assert.equal(data.data, dummy);
                assert.equal(data.target, e2);
                assert.equal(data.type, event);
            }).emit(event, dummy);
        });

        it('must fail if first argument is not array or string', function() {
            var e2 = new E2();
            try {
                e2.emit(123);
            } catch (e) {
                assert.ok(e instanceof TypeError);
            }

            try {
                e2.emit({});

            } catch (e) {
                assert.ok(e instanceof TypeError);
            }
        })
    });

    describe('e2.emitAsync', function() {
        it('must call callback async', function(done) {
            var e2 = new E2();
            e2.on(event, function() {
                done();
            }).emitAsync(event);
        });
    });

    describe('e2.off', function() {
        it('must not call callbacks if event released', function() {
            var e2 = new E2();
            e2.on(event, fail).off(event).emit(event);
            assert.ok('true');
        });

        it('must not call callbacks if callback released directly', function() {
            var e2 = new E2();
            e2.on(event, dummyFunction).on(event, fail).off(event, fail).emit(event);
        });

        it('must not call callbacks only for released events', function() {
            var e2 = new E2();
            e2.on({
                'dummy': dummyFunction,
                'another-dummy': fail
            }).off(anotherEvent).emit(eventsArray);
        });

        it('must fail with TypeError if first argument is not Object, string or array', function() {
            var e2 = new E2();
            try {
                e2.off(123);
            } catch (e) {
                assert.ok(e instanceof TypeError);
            }

        });

        it('must remove all handlers from several events', function() {
            var e2 = new E2();
            e2.on(eventsArray, fail).off(eventsArray).emit(event);

            assert.ok(e2.__e2__.callbacks[event].length === 0 && e2.__e2__.callbacks[anotherEvent].length === 0);
        });
    });

    describe('extend', function() {
        it('must support prototype inheritance', function() {
            function SomeClass() {

            }

            SomeClass.prototype = new E2;

            var instance = new SomeClass;

            instance.on(event, dummyFunction).emit(event);
        });

        it('must support object inheritance', function() {
            var instance = Object.create(new E2);

            instance.on(event, dummyFunction).emit(event);
        });
    });
});
