//go:build windows

package power

import "syscall"

const (
	esContinuous     = 0x80000000
	esSystemRequired = 0x00000001
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	setThreadExecutionState = kernel32.NewProc("SetThreadExecutionState")
)

func SetKeepAwake(enabled bool) error {
	flags := uintptr(esContinuous)
	if enabled {
		flags |= esSystemRequired
	}
	result, _, err := setThreadExecutionState.Call(flags)
	if result == 0 {
		return err
	}
	return nil
}
