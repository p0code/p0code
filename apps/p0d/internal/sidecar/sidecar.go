// Package sidecar runs the legacy Node server (apps/server) on loopback while
// something needs it, and stops it after it sits idle.
package sidecar

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// Headers the legacy server trusts from p0d (see apps/server/src/auth/EnvironmentAuth.ts).
const (
	TokenHeader   = "X-P0d-Internal-Token"
	SessionHeader = "X-P0d-Session-Id"
	tokenEnv      = "P0D_INTERNAL_TOKEN"
)

const (
	startTimeout = 2 * time.Minute
	stopTimeout  = 10 * time.Second
)

// Status is what the p0d.subscribeStatus stream reports.
type Status struct {
	State string `json:"state"` // stopped | starting | running
	Pid   int    `json:"pid,omitempty"`
	Port  int    `json:"port,omitempty"`
	Users int    `json:"users"`
}

// Manager owns at most one legacy server process.
type Manager struct {
	// Command starts the legacy server; p0d appends --host, --port and --base-dir.
	Command []string
	// BaseDir is passed as --base-dir; the server keeps its state in BaseDir/userdata.
	BaseDir     string
	IdleTimeout time.Duration
	Logger      *log.Logger
	// Output receives the legacy server's stdout and stderr.
	Output io.Writer

	// Token is the secret only p0d and its sidecar know.
	Token string

	mu      sync.Mutex
	proc    *process
	users   int
	idle    *time.Timer
	changed chan struct{}
}

type process struct {
	cmd    *exec.Cmd
	port   int
	ready  chan struct{}
	exited chan struct{}
	err    error
}

// New prepares a manager; nothing starts until Acquire.
func New(command []string, baseDir string, idle time.Duration) *Manager {
	token := make([]byte, 32)
	rand.Read(token)
	return &Manager{
		Command:     command,
		BaseDir:     baseDir,
		IdleTimeout: idle,
		Logger:      log.New(os.Stderr, "p0d: ", log.LstdFlags),
		Output:      os.Stderr,
		Token:       hex.EncodeToString(token),
		changed:     make(chan struct{}),
	}
}

// Acquire starts the server if needed and holds it until release is called.
func (m *Manager) Acquire(ctx context.Context) (addr string, release func(), err error) {
	m.mu.Lock()
	if m.idle != nil {
		m.idle.Stop()
		m.idle = nil
	}
	p := m.proc
	if p == nil {
		if p, err = m.start(); err != nil {
			m.mu.Unlock()
			return "", nil, err
		}
	}
	m.users++
	m.notifyLocked()
	m.mu.Unlock()

	var once sync.Once
	release = func() { once.Do(m.release) }
	select {
	case <-p.ready:
		if p.err != nil {
			release()
			return "", nil, p.err
		}
		return "127.0.0.1:" + strconv.Itoa(p.port), release, nil
	case <-ctx.Done():
		release()
		return "", nil, ctx.Err()
	}
}

func (m *Manager) release() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.users--
	m.notifyLocked()
	if m.users > 0 || m.proc == nil {
		return
	}
	p := m.proc
	m.idle = time.AfterFunc(m.IdleTimeout, func() {
		m.mu.Lock()
		stop := m.proc == p && m.users == 0
		m.mu.Unlock()
		if stop {
			m.Logger.Printf("legacy server idle for %s, stopping it", m.IdleTimeout)
			m.stopProcess(p)
		}
	})
}

// Status reports the current state and a channel closed on the next change.
func (m *Manager) Status() (Status, <-chan struct{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := Status{State: "stopped", Users: m.users}
	if p := m.proc; p != nil {
		s.State, s.Port = "starting", p.port
		if p.cmd.Process != nil {
			s.Pid = p.cmd.Process.Pid
		}
		select {
		case <-p.ready:
			s.State = "running"
		default:
		}
	}
	return s, m.changed
}

func (m *Manager) notifyLocked() {
	close(m.changed)
	m.changed = make(chan struct{})
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// start launches the process. Caller holds m.mu.
func (m *Manager) start() (*process, error) {
	port, err := freePort()
	if err != nil {
		return nil, err
	}
	args := append(append([]string{}, m.Command[1:]...),
		"--host", "127.0.0.1", "--port", strconv.Itoa(port), "--base-dir", m.BaseDir)
	cmd := exec.Command(m.Command[0], args...)
	cmd.Env = append(os.Environ(), tokenEnv+"="+m.Token, "T3CODE_NO_BROWSER=1")
	cmd.Stdout, cmd.Stderr = m.Output, m.Output
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start legacy server: %w", err)
	}
	m.Logger.Printf("started legacy server pid %d on 127.0.0.1:%d", cmd.Process.Pid, port)
	p := &process{cmd: cmd, port: port, ready: make(chan struct{}), exited: make(chan struct{})}
	m.proc = p
	go func() {
		err := cmd.Wait()
		m.mu.Lock()
		if m.proc == p {
			m.proc = nil
			if m.idle != nil {
				m.idle.Stop()
				m.idle = nil
			}
			m.notifyLocked()
		}
		m.mu.Unlock()
		m.Logger.Printf("legacy server pid %d exited: %v", cmd.Process.Pid, err)
		close(p.exited)
	}()
	go m.awaitReady(p)
	return p, nil
}

// awaitReady polls until the server answers HTTP.
func (m *Manager) awaitReady(p *process) {
	defer func() {
		close(p.ready)
		m.mu.Lock()
		m.notifyLocked()
		m.mu.Unlock()
	}()
	client := &http.Client{Timeout: 2 * time.Second}
	url := fmt.Sprintf("http://127.0.0.1:%d/.well-known/t3/environment", p.port)
	deadline := time.Now().Add(startTimeout)
	for time.Now().Before(deadline) {
		select {
		case <-p.exited:
			p.err = errors.New("legacy server exited during startup")
			return
		case <-time.After(150 * time.Millisecond):
		}
		if res, err := client.Get(url); err == nil {
			res.Body.Close()
			if res.StatusCode < 500 {
				return
			}
		}
	}
	p.err = errors.New("legacy server did not start in time")
	m.stopProcess(p)
}

func (m *Manager) stopProcess(p *process) {
	proc := p.cmd.Process
	if runtime.GOOS == "windows" {
		proc.Kill()
	} else {
		proc.Signal(syscall.SIGTERM)
	}
	select {
	case <-p.exited:
	case <-time.After(stopTimeout):
		proc.Kill()
		<-p.exited
	}
}

// Stop ends the server, if it runs.
func (m *Manager) Stop() {
	m.mu.Lock()
	p := m.proc
	m.mu.Unlock()
	if p != nil {
		m.stopProcess(p)
	}
}
