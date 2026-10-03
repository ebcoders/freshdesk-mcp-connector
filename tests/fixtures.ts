import type { RawContact, RawConversation, RawTicket } from "../src/mappers.js";

// Shapes follow the Freshdesk API v2 documentation examples; all data is fictional.

export function rawTicket(over: Partial<RawTicket> = {}): RawTicket {
  return {
    id: 101,
    subject: "Order #A-1042 arrived damaged",
    status: 2,
    priority: 3,
    source: 1,
    type: "Problem",
    tags: ["damaged", "priority-customer"],
    requester_id: 5001,
    responder_id: 7001,
    group_id: 9001,
    company_id: null,
    due_by: "2026-10-05T10:00:00Z",
    fr_due_by: "2026-10-04T10:00:00Z",
    created_at: "2026-10-01T09:15:00Z",
    updated_at: "2026-10-02T11:20:00Z",
    description: "<div>The parcel was crushed.</div>",
    description_text: "The parcel was crushed.",
    cc_emails: ["ops@example.com"],
    custom_fields: { cf_order_id: "A-1042" },
    ...over,
  };
}

export function rawConversation(over: Partial<RawConversation> = {}): RawConversation {
  return {
    id: 3001,
    body: "<div>Could you send a photo?</div>",
    body_text: "Could you send a photo?",
    incoming: false,
    private: false,
    user_id: 7001,
    from_email: "support@acme-demo.example.com",
    to_emails: ["priya.nair@example.com"],
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:00:00Z",
    ...over,
  };
}

export function rawContact(over: Partial<RawContact> = {}): RawContact {
  return {
    id: 5001,
    name: "Priya Nair",
    email: "priya.nair@example.com",
    phone: "+1-555-0101",
    mobile: null,
    company_id: null,
    job_title: "Store owner",
    active: true,
    tags: ["vip"],
    created_at: "2026-09-01T08:00:00Z",
    updated_at: "2026-09-15T08:00:00Z",
    ...over,
  };
}
