const { EventEmitter } = require('events');

// In-process pub/sub: the capture route publishes each new request, and the dashboard's
// server-sent-events stream (/api/stream) forwards them to open browsers.
const events = new EventEmitter();
events.setMaxListeners(0);

module.exports = {
    publish: summary => events.emit('request', summary),
    subscribe: listener => {
        events.on('request', listener);
        return () => events.off('request', listener);
    },
};
