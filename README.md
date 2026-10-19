# Payvol examples

Runnable examples of [Payvol](https://payvol.xyz), a portable request-to-pay artifact (a `canton:`
URI and its canonical JSON) that a wallet fulfils as a Canton Token Standard transfer. Each example
is self-contained and depends only on the published `@payvol/*` packages on npm.

| Example | What it shows |
|---|---|
| [`examples/cbtc`](examples/cbtc/) | Build and verify a CBTC payment request against CBTC's registry, then pay, accept and observe it on your own participant. |

The guide that walks through the CBTC example is [`docs/cbtc-guide.md`](docs/cbtc-guide.md).

## License

Apache-2.0. See [LICENSE](LICENSE). The marks and fonts in the diagrams are not under Apache-2.0: see [NOTICE](NOTICE).
