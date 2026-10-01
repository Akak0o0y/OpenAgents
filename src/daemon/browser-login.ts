/** Open a login entry point, not a profile's anonymous signup redirect. */
export function loginUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use a login URL without embedded credentials.');
  if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) {
    url.protocol = 'https:'; url.hostname = 'x.com'; url.port = '';
    url.pathname = '/i/flow/login'; url.search = ''; url.hash = '';
  }
  return url;
}

export function unfinishedLogin(value: string): boolean {
  const url = new URL(value);
  return /\/(login|signin|sign-in)(\/|$)/i.test(url.pathname)
    || (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)
      && /^\/i\/(flow|jf\/onboarding)\//i.test(url.pathname));
}

export function rejectedGoogleLogin(value: string): boolean {
  const url = new URL(value);
  return url.hostname === 'accounts.google.com' && /\/signin\/rejected(?:\/|$)/i.test(url.pathname);
}
