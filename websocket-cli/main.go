// Command websocket-cli sends one prompt to the Visual Browser Agent Chrome
// extension over its local WebSocket bridge and prints the answer.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultHost = "127.0.0.1"
	defaultPort = 8765
)

func main() {
	os.Exit(run())
}

func run() int {
	log.SetFlags(0)
	log.SetPrefix("websocket-cli: ")
	log.SetOutput(os.Stderr)

	host := flag.String("host", defaultHost, "interface to bind to")
	port := flag.Int("port", defaultPort, "TCP port to listen on")
	timeout := flag.Duration("timeout", 0, "give up after this long (0 waits indefinitely)")

	flag.Usage = func() {
		name := filepath.Base(os.Args[0])
		fmt.Fprintf(flag.CommandLine.Output(), `Usage: %s [flags] <prompt>

Listens for the Chrome extension on a WebSocket, sends it <prompt> as soon as
it connects, and prints the answer the extension sends back.

Examples:
  %s "What is on this page?"
  %s -port 9000 "Open example.com" | tee answer.txt

The answer is written to stdout so it can be piped; status messages go to
stderr. Flags must come before <prompt>.

`, name, name, name)
		flag.PrintDefaults()
	}
	flag.Parse()

	prompt := strings.TrimSpace(strings.Join(flag.Args(), " "))
	if prompt == "" {
		flag.Usage()
		return 2
	}
	if *port < 1 || *port > 65535 {
		log.Printf("invalid port %d", *port)
		return 2
	}

	address := net.JoinHostPort(*host, strconv.Itoa(*port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		log.Printf("cannot listen on %s: %v", address, err)
		return 1
	}
	defer listener.Close()
	log.Printf("listening on ws://%s", listener.Addr())

	result := make(chan string, 1)
	var promptSent atomic.Bool
	var deliver sync.Once

	upgrader := websocket.Upgrader{
		// The extension connects from a chrome-extension:// origin, so the
		// default same-host origin check would reject it.
		CheckOrigin: func(*http.Request) bool { return true },
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("websocket upgrade failed: %v", err)
			return
		}
		defer conn.Close()

		if promptSent.CompareAndSwap(false, true) {
			log.Printf("extension connected; sending prompt")
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.TextMessage, []byte(prompt)); err != nil {
				log.Printf("could not send prompt: %v", err)
				// Let the extension's next connection try again.
				promptSent.Store(false)
				return
			}
			_ = conn.SetWriteDeadline(time.Time{})
		} else {
			log.Printf("another client connected; waiting for the answer")
		}

		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("connection closed before an answer arrived: %v", err)
			return
		}
		deliver.Do(func() { result <- string(message) })
	})

	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()

	shutdown := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}

	var timeoutC <-chan time.Time
	if *timeout > 0 {
		timer := time.NewTimer(*timeout)
		defer timer.Stop()
		timeoutC = timer.C
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)

	select {
	case answer := <-result:
		if _, err := fmt.Fprintln(os.Stdout, answer); err != nil {
			log.Printf("could not write answer: %v", err)
			shutdown()
			return 1
		}
		shutdown()
		return 0
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server error: %v", err)
			return 1
		}
		return 0
	case <-timeoutC:
		log.Printf("timed out after %s waiting for the extension", *timeout)
		shutdown()
		return 1
	case sig := <-sigCh:
		log.Printf("received %s; exiting", sig)
		shutdown()
		if s, ok := sig.(syscall.Signal); ok {
			return 128 + int(s)
		}
		return 1
	}
}
