export async function getJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: options.headers ?? {},
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Request failed with ${response.status}: ${text.slice(0, 250)}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
