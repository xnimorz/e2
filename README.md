## E2

E2 is a custom event emitter for Node.js and the browser with async events supporting.

e2 supporting CommonJS and AMD modules.

### Installing

#### Node.js

Using npm:

```
npm install e2
```

#### Browsers

Using bower:

```
bower install e2
```

Using script tag:

```
<script type="text/javascript" src="e2.min.js"></script>
```

### Simple usage

As standalone object

```
var E2 = require('e2');

var e2 = new E2;

e2.on('my-event-name', function myEventHandler() {});

e2.emit('my-event-name', {someEventData: someEventValue});

```

#### Using inheritance

Constructors:

```
function SomeClass() {

}

SomeClass.prototype = new E2;

var instance = new SomeClass;

instance.on('event', eventHandler).emit('event');

```

Object.create:

```
var instance = Object.create(new E2);

instance.on('event', eventHandler).emit('event');
```

## Description

### Create E2 instance:

```
var e2 = new E2();
```

You can inherit custom Objects from e2:

1)

```
function Constructor() {}
Constructor.prototype = new E2;

var instance = new Constructor;
```

2)

```
var instance = Object.create(new E2);
```

### Listening to events

```
// Basic
e2.on('event', handler);

// assign handler to several events
e2.on(['my-event', 'second-event], handler)

// once
e2.once('event', handler);
//or
e2.on('event', handler, {once: true});

//using object
e2.on({
    event: eventHandler,
    anotherEvent: anotherEventHandler
});

```

### Emitting
```
e2.emit('event-name');

// with data
e2.emit('event-name', {foo: 'bar'});

// emit several events
e2.emit(['event-name', 'another-event']);
e2.emit(['event-name', 'another-event'], {foo: 'bar'});

// Emit event async
e2.emitAsync('event-name');
e2.emitAsync('event-name', {foo: 'bar'});
e2.emitAsync(['event-name', 'another-event']);
e2.emitAsync(['event-name', 'another-event'], {foo: 'bar'});
```

#### Event data
Events are objects having the following keys:

* data: the data attached to the event.
* type: the event type.
* target: the event emitter.

For example:

```
e2.on('event', function(e) {
    console.log(e.type) //-> 'event'
    console.log(e.target) //-> e2
    console.log(e.data) //-> {foo: 'bar'}
}.emit('event', {foo: 'bar'});

```

### Removing event handler
```
// Remove all handlers attached to the given event
e2.off('event');

// Remove handler from event directly
e2.off('event', handler);
```

### Get event listeners

```
// Return every matching handlers for a given event name
e2.listeners('event');
```
