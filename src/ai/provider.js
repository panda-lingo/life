// Real provider adapter skeleton. Configure with:
//   window.LIFESPEAK_AI = createHttpProvider({ endpoint, apiKey, model })
// The endpoint must accept { prompt, image? } and return { text }.
// (Image = optional dataURL screenshot for visual grounding; constraint is
//  text+image in / text out, which this honors.)

export function createHttpProvider({ endpoint, apiKey, model }) {
  return {
    async complete({ prompt, image = null }) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, prompt, image }),
      });
      if (!res.ok) throw new Error(`AI provider ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.text;
    },
  };
}
