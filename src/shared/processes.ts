/** The processes on this machine that Studio's windows leave things to one another by. */

/** Whether process `pid` is running: as this user's, or as another's, which signals refuse. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
