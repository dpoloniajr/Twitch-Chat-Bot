// Patches global console methods to prepend a [HH:MM:SS] timestamp to every log call.
// Require this module once at the top of each entry-point file.
// The guard prevents double-patching if the module is required more than once.

if (console.__timestamped) return;
console.__timestamped = true;

function getTimestamp() {
    const d = new Date();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `[${h}:${m}:${s}]`;
}

// Variadic text methods: timestamp is prepended as the first argument.
['log', 'warn', 'error', 'info', 'debug', 'trace'].forEach(method => {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        original(getTimestamp(), ...args);
    };
});

// Structural methods: timestamp is printed on a separate line first because
// console.dir and console.table treat their first argument specially (object
// to inspect / tabulate), so prepending to args would break them.
['dir', 'table'].forEach(method => {
    const original = console[method].bind(console);
    console[method] = (...args) => {
        process.stdout.write(getTimestamp() + '\n');
        original(...args);
    };
});
