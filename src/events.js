const { EventEmitter } = require('events');

// In-process pub/sub used to push newly captured requests to dashboard SSE streams
const events = new EventEmitter();
events.setMaxListeners(0);

const channel = binId => `bin:${binId}`;

module.exports = {
    publish: (binId, payload) => events.emit(channel(binId), payload),
    subscribe: (binId, listener) => {
        events.on(channel(binId), listener);
        return () => events.off(channel(binId), listener);
    },
};
