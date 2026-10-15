# snitch-cli

[Snitch](https://github.com/monjar/mobile-app-qa-sdk) QA tickets from the terminal, and an MCP server so coding agents
can read them too: what the tester wrote, the screenshot, the screen recording as frames, the timeline and logs.

```sh
npx snitch-cli login --server https://snitch.example.com   # approve the code in the dashboard
npx snitch-cli tickets
npx snitch-cli ticket APP-12 --download                    # screenshot, video frames, timeline.txt, report.md
claude mcp add snitch -- npx -y snitch-cli mcp            # or any MCP client
npx snitch-cli skill install                               # an agent skill: reports in, pull requests out
```

Needs Snitch server 0.5+, Node 22.13+, and ffmpeg for video frames. Tokens are kept in the OS credential store.

Full docs: [docs/cli.md](https://github.com/monjar/mobile-app-qa-sdk/blob/master/docs/cli.md). MIT licensed.
