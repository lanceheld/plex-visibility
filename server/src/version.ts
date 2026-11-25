/** Set by the Docker build (`git describe` for snapshots, the release version for releases). */
export const APP_VERSION = process.env.APP_VERSION?.trim() || 'dev';
