import api from './api';

/**
 * Downloads a file from the API with the user's access token. A plain <a href="/api/..."> cannot be used: the
 * token is held in memory and sent as an Authorization header, which a browser link does not carry (it got 401).
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  let res;
  try {
    res = await api.get(path, { responseType: 'blob' });
  } catch (err: any) {
    // Error bodies arrive as a Blob too; surface the server's message.
    const body = err.response?.data;
    if (body instanceof Blob) {
      try {
        const parsed = JSON.parse(await body.text());
        throw new Error(parsed.error || `download failed (HTTP ${err.response.status})`);
      } catch (inner: any) {
        if (inner instanceof SyntaxError) throw new Error(`download failed (HTTP ${err.response.status})`);
        throw inner;
      }
    }
    throw err;
  }
  const disposition = String(res.headers['content-disposition'] || '');
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] || fallbackName;
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
