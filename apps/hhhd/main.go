// hhhd is HHHCode's native backend. See docs/internals/backend-split/PLAN.md.
package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"hhhd/internal/server"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const usage = `usage:
  hhhd serve --home <dir> [--host 127.0.0.1] [--port 0] [--ready-file <path>] [--legacy-server <cmd>]
  hhhd version
  hhhd service install|uninstall|start|stop|status
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println(version)
	case "service":
		err = service(os.Args[2:])
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "hhhd:", err)
		os.Exit(1)
	}
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	home := fs.String("home", "", "data directory the server uses (e.g. ~/.hhh/userdata)")
	host := fs.String("host", "127.0.0.1", "interface to listen on")
	port := fs.Int("port", 0, "port to listen on (0 picks a free one)")
	readyFile := fs.String("ready-file", "", "write {pid,port,url} JSON here once listening")
	legacy := fs.String("legacy-server", "", "command that starts the legacy Node server")
	legacyIdle := fs.Duration("legacy-idle-timeout", 5*time.Minute, "stop the legacy server after it is unused this long")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *home == "" {
		return errors.New("serve needs --home")
	}
	command, err := splitCommand(*legacy)
	if err != nil {
		return fmt.Errorf("--legacy-server: %w", err)
	}
	logger := log.New(os.Stderr, "hhhd: ", log.LstdFlags)
	s, err := server.Start(server.Config{
		Home: *home, Host: *host, Port: *port, ReadyFile: *readyFile,
		Legacy: command, LegacyIdle: *legacyIdle, Version: version, Logger: logger,
	})
	if err != nil {
		return err
	}
	logger.Printf("listening on %s", s.URL())
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	logger.Printf("shutting down")
	return s.Close()
}

// splitCommand splits a command line on whitespace, honoring single and double quotes.
// Inside double quotes only \" and \\ are escapes, so Windows paths stay intact.
func splitCommand(line string) ([]string, error) {
	var (
		args   []string
		cur    strings.Builder
		inWord bool
		quote  rune
	)
	runes := []rune(line)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case quote == '"' && r == '\\' && i+1 < len(runes) && (runes[i+1] == '"' || runes[i+1] == '\\'):
			i++
			cur.WriteRune(runes[i])
		case quote != 0 && r == quote:
			quote = 0
		case quote != 0:
			cur.WriteRune(r)
		case r == '"' || r == '\'':
			quote, inWord = r, true
		case r == ' ' || r == '\t' || r == '\n':
			if inWord {
				args = append(args, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteRune(r)
			inWord = true
		}
	}
	if quote != 0 {
		return nil, errors.New("unterminated quote")
	}
	if inWord {
		args = append(args, cur.String())
	}
	return args, nil
}

func service(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: hhhd service install|uninstall|start|stop|status")
	}
	switch args[0] {
	case "install", "uninstall", "start", "stop", "status":
		return fmt.Errorf("service %s is not implemented yet", args[0])
	}
	return fmt.Errorf("unknown service command %q", args[0])
}
