# seek-bzip runtime

Vendored from the MIT-licensed npm `seek-bzip@2.0.0` package
([upstream](https://github.com/cscott/seek-bzip/tree/v2.0.0)). The four runtime
modules and original license are retained. The only runtime change replaces all
ten numeric `new Buffer(size)` allocations with `Buffer.alloc(size)`.

The published dependency and upstream master still use deprecated Buffer
constructors. Each short-lived TDWR worker emitted DEP0005, flooding the service
journal. Keeping this small patch local fixes both development and bundled workers
without suppressing warnings, install-time patches or a different decompressor.
CLI tools, their commander dependency and upstream test tooling are not included.
The original decoding algorithm and bounded output callback are unchanged.

`test/weather-radar.test.ts` exercises captured TDWR values, partial sweeps,
corrupt input, checksum failures and output bounds. Run it with
`node --throw-deprecation --import=tsx --test test/weather-radar.test.ts` when
updating this copy. Keep the license with distributed source.
