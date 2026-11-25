/** `url` without trailing slashes. A loop, not /\/+$/, which backtracks on input like "a//////b". */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') {
    end--;
  }
  return url.slice(0, end);
}
