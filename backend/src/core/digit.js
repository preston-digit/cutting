// Digit ERP GraphQL client — REUSABLE CORE. Do not put module-specific queries
// here; features define their own operations and call digitRequest().
//
// The Digit API is a single GraphQL endpoint. The bearer token lives ONLY here,
// server-side, and is never sent to the browser. Features expose allowlisted
// routes that call through to Digit using this primitive.

const DIGIT_API_URL =
  process.env.DIGIT_API_URL || "https://api.digit-software.com/graphql";
const DIGIT_API_TOKEN = process.env.DIGIT_API_TOKEN || "";

/**
 * Execute a GraphQL operation against Digit.
 * @param {string} query - GraphQL query/mutation document.
 * @param {object} variables - GraphQL variables.
 * @returns {Promise<object>} the `data` field of the GraphQL response.
 * @throws if the token is missing, the request fails, or GraphQL returns errors.
 */
export async function digitRequest(query, variables = {}) {
  if (!DIGIT_API_TOKEN) {
    throw new Error("DIGIT_API_TOKEN is not configured (server-side only).");
  }

  const res = await fetch(DIGIT_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DIGIT_API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Digit API HTTP ${res.status}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Digit GraphQL error: ${json.errors[0].message}`);
  }
  return json.data;
}
