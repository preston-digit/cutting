// Digit operations for the PROJECTS feature (EXAMPLE — delete with the feature).
//
// This is the convention for touching any Digit module: define the named,
// allowlisted GraphQL operations here and call core's digitRequest(). The
// frontend never sends GraphQL; it calls this feature's routes.
import { digitRequest } from "../../core/digit.js";

// --- Read sales order ------------------------------------------------------
// Items are embedded in the SO response (no separate items call). There is no
// single order-total field — contract value is derived from the line items.
const ORDER_QUERY = `
  query ($orderId: ID!) {
    order(orderId: $orderId) {
      id
      orderNumber
      orderStatus
      invoiceStatus
      orderDate
      createdAt
      projectId
      projectName
      notes
      customer { id name }
      items {
        id
        quantity
        item { id name }
        cost { costAmount currency { code symbol } }
        jobs { nodes { id jobNumber } }
      }
    }
  }
`;

export async function getOrder(orderId) {
  const data = await digitRequest(ORDER_QUERY, { orderId });
  return data.order;
}

/** Derived contract value = Σ(item.cost.costAmount × quantity). Display cache only. */
export function deriveContractValue(order) {
  return (order?.items || []).reduce(
    (sum, line) =>
      sum + Number(line.cost?.costAmount || 0) * Number(line.quantity || 0),
    0
  );
}

// --- Create job ------------------------------------------------------------
// CreateJobInput required (non-null): itemId (PRODUCT item id = order
// items[].item.id), type, priority, packingType, status. Optional SO linkage:
// salesOrderId, salesOrderItemRowId (= order items[].id line row).
const CREATE_JOB_MUTATION = `
  mutation ($input: CreateJobInput!) {
    createJob(input: $input) {
      job { id jobNumber }
    }
  }
`;

export const JOB_DEFAULTS = {
  type: "PRODUCTION",
  priority: "NORMAL",
  packingType: "STANDARD_PACKING",
  status: "NOT_STARTED",
};

export async function createJob(input) {
  const data = await digitRequest(CREATE_JOB_MUTATION, {
    input: { ...JOB_DEFAULTS, ...input },
  });
  return data.createJob.job;
}
