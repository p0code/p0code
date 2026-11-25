package server

import (
	"context"
	"time"

	"p0d/internal/rpc"
	"p0d/internal/sidecar"
)

// registerHandlers lists the RPC methods ported to Go. Scopes follow
// RPC_REQUIRED_SCOPES in apps/server/src/auth/RpcAuthorization.ts.
func registerHandlers(reg *rpc.Registry, s *Server) {
	// server.probe: payload {}, success { serverTime?: IsoDateTime }.
	reg.Unary("server.probe", "orchestration:read", func(ctx context.Context, call *rpc.Call) (any, error) {
		return map[string]string{"serverTime": time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}, nil
	})

	// p0d.subscribeStatus is p0d's own: the backend version and whether the legacy
	// server is running. It emits the current status, then every change.
	reg.Stream("p0d.subscribeStatus", "orchestration:read", func(ctx context.Context, call *rpc.Call, emit func(...any) error) error {
		type status struct {
			Version string          `json:"version"`
			Legacy  *sidecar.Status `json:"legacy,omitempty"`
		}
		for {
			next := status{Version: s.cfg.Version}
			var changed <-chan struct{}
			if s.legacy != nil {
				st, ch := s.legacy.Status()
				next.Legacy, changed = &st, ch
			}
			if err := emit(next); err != nil {
				return err
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-changed:
			}
		}
	})
}
