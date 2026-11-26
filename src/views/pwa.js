// Registers the service worker (see sw.js). Browsers offer it only on HTTPS or localhost; elsewhere this does nothing.
(function () {
    'use strict';

    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js').catch(function () {
            // Not fatal: the app works the same without offline support
        });
    });
})();
