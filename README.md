# agentphone-verified-caller

Verified caller ID for AI phone agents built on [AgentPhone](https://agentphone.ai).

When an AI agent calls you, caller ID can be spoofed and anything the agent says about
itself is just words. This project looks up the platform's own record of the live call to
show which agent placed it and who owns that agent, and flags a mismatch when the caller
claims to represent someone else. The verdict is delivered as a desktop notification that
opens a page with a signed, independently verifiable token.

> **Status: work in progress.** This is an unofficial prototype, not an AgentPhone product.

## Quickstart

Requires Node 20.19 or later.

```sh
npm ci
cp .env.example .env   # then fill in your values
npm run dev
curl http://127.0.0.1:3000/health
```

A missing or invalid setting stops startup with a list of every problem.

## Development

```sh
npm test            # node:test
npm run lint
npm run format      # check only; format:write to fix
npm run typecheck
npm run build       # emits dist/
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the code is laid out and
[docs/adr/](docs/adr/) for the decisions behind it.

## License

[MIT](LICENSE)
