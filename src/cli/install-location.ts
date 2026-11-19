// Where this copy of stolik runs from. `npx stolik ...` runs the package from npm's cache (~/.npm/_npx/<hash>/...), and
// npm may clean that cache at any time. A systemd unit or LaunchAgent that points into it would break later, so the
// service commands refuse to write one from there. Setup still runs: only the service step needs a permanent install.
export function isNpxInstall(path: string): boolean {
  return /(^|[\\/])_npx[\\/]/.test(path)
}

export const NPX_SERVICE_MESSAGE =
  'stolik runs from the npx cache, which npm may clean. The service needs a permanent install: ' +
  'run `npm install -g stolik`, then `stolik setup` (or `stolik service install`).'
