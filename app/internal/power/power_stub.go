//go:build !windows

package power

func SetKeepAwake(enabled bool) error {
	return nil
}
