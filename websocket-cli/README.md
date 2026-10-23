# websocket-cli

A minimal Go CLI for the Visual Browser Agent's local WebSocket bridge. It
listens on port **8765** (the port the extension connects to), waits for the
extension, sends it one prompt, and prints the answer it sends back.

## Build

```sh
go build -o websocket-cli .
```

## Run

```sh
./websocket-cli "What is on this page?"
```

The extension may take up to ten seconds to notice the server and connect, so
the command waits until it does.

The answer is the only thing written to stdout, so the command pipes normally:

```sh
./websocket-cli "Summarize this page" > answer.txt
./websocket-cli "Summarize this page" | pbcopy
```

Status messages are written to stderr. Exit status is `0` on success, `1` on a
runtime error or timeout, `2` for bad usage, and `130` when interrupted with
Ctrl-C.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `-host` | `127.0.0.1` | Interface to bind to |
| `-port` | `8765` | TCP port the extension expects |
| `-timeout` | `0` | Give up after a duration such as `30s` (`0` waits forever) |
