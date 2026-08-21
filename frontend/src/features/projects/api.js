// PROJECTS feature API (EXAMPLE — delete with the feature). Built on core's
// apiRequest — calls our backend routes, never Digit directly.
import { apiRequest } from "../../core/api.js";

export const projectsApi = {
  list: () => apiRequest("/api/projects"),
  createFromOrder: (orderId, fields) =>
    apiRequest(`/api/projects/from-order/${orderId}`, {
      method: "POST",
      body: JSON.stringify(fields || {}),
    }),
  getOrder: (id) => apiRequest(`/api/projects/${id}/order`),
  createJob: (id, input) =>
    apiRequest(`/api/projects/${id}/jobs`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
