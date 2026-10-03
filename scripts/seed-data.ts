import type { PriorityLabel, StatusLabel } from "../src/schemas.js";

/** Every seeded ticket carries this tag so seeded data is easy to find and remove. */
export const SEED_TAG = "fictional-seed";

export interface SeedContact {
  name: string;
  email: string;
  phone: string;
  job_title: string;
}

export interface SeedNote {
  body: string;
  /** true = internal agent note; false + incoming = simulated customer reply */
  private: boolean;
  incoming?: boolean;
}

export interface SeedTicket {
  subject: string;
  description: string;
  requester: string; // contact email
  status: StatusLabel;
  priority: PriorityLabel;
  tags: string[];
  notes?: SeedNote[];
}

// All people, emails (RFC 2606 example.com) and phone numbers (555-01xx) are fictional.
export const CONTACTS: SeedContact[] = [
  { name: "Priya Nair", email: "priya.nair@example.com", phone: "+1-555-0101", job_title: "Store owner" },
  { name: "Arjun Mehta", email: "arjun.mehta@example.com", phone: "+1-555-0102", job_title: "Operations lead" },
  { name: "Sofia Lindqvist", email: "sofia.lindqvist@example.com", phone: "+1-555-0103", job_title: "Buyer" },
  { name: "Kwame Mensah", email: "kwame.mensah@example.com", phone: "+1-555-0104", job_title: "Finance manager" },
  { name: "Mei Chen", email: "mei.chen@example.com", phone: "+1-555-0105", job_title: "Customer" },
  { name: "Lucas Moreau", email: "lucas.moreau@example.com", phone: "+1-555-0106", job_title: "Customer" },
  { name: "Aisha Rahman", email: "aisha.rahman@example.com", phone: "+1-555-0107", job_title: "Procurement" },
  { name: "Diego Alvarez", email: "diego.alvarez@example.com", phone: "+1-555-0108", job_title: "Customer" },
  { name: "Hannah Okafor", email: "hannah.okafor@example.com", phone: "+1-555-0109", job_title: "Store manager" },
  { name: "Tomás Novak", email: "tomas.novak@example.com", phone: "+1-555-0110", job_title: "Customer" },
];

export const TICKETS: SeedTicket[] = [
  { subject: "Order #A-1042 arrived damaged", description: "The parcel was crushed and two mugs are broken.", requester: "priya.nair@example.com", status: "Open", priority: "High", tags: ["damaged", "vip"], notes: [{ body: "Asked customer for photos of the packaging.", private: true }, { body: "Photos attached — box was clearly crushed.", private: false, incoming: true }] },
  { subject: "Refund not received for order #A-0988", description: "Refund was approved 10 days ago but has not reached my card.", requester: "kwame.mensah@example.com", status: "Pending", priority: "Urgent", tags: ["refund", "payments"], notes: [{ body: "Escalated to payments team; awaiting gateway reference.", private: true }] },
  { subject: "Autopay failed for monthly subscription", description: "My card was declined for the September autopay. How do I retry?", requester: "mei.chen@example.com", status: "Open", priority: "Medium", tags: ["payments", "subscription"] },
  { subject: "Wrong size delivered", description: "Ordered size M jacket, received XL.", requester: "lucas.moreau@example.com", status: "Open", priority: "Medium", tags: ["exchange"] },
  { subject: "Bulk order quote for 500 units", description: "Requesting a quote for 500 branded tote bags.", requester: "aisha.rahman@example.com", status: "Pending", priority: "Low", tags: ["sales", "b2b"] },
  { subject: "Tracking link shows no updates", description: "Tracking for order #A-1101 has not updated in 6 days.", requester: "diego.alvarez@example.com", status: "Open", priority: "High", tags: ["shipping"], notes: [{ body: "Courier confirmed the parcel is held at the depot.", private: true }] },
  { subject: "Invoice missing GST number", description: "Our invoice for order #A-1003 is missing our tax number.", requester: "arjun.mehta@example.com", status: "Resolved", priority: "Low", tags: ["invoice", "b2b"] },
  { subject: "Cannot log in to my account", description: "Password reset email never arrives.", requester: "tomas.novak@example.com", status: "Open", priority: "Medium", tags: ["account"] },
  { subject: "Discount code not applied", description: "Code AUTUMN10 was accepted but the total did not change.", requester: "mei.chen@example.com", status: "Closed", priority: "Low", tags: ["promotions"] },
  { subject: "Item out of stock after payment", description: "I paid for the ceramic vase but was told it's out of stock.", requester: "hannah.okafor@example.com", status: "Pending", priority: "High", tags: ["inventory", "refund"] },
  { subject: "Duplicate charge on card", description: "I was charged twice for order #A-1120.", requester: "sofia.lindqvist@example.com", status: "Open", priority: "Urgent", tags: ["payments", "vip"], notes: [{ body: "Confirmed duplicate capture in gateway logs; reversal initiated.", private: true }, { body: "Thanks, I can see a pending reversal now.", private: false, incoming: true }] },
  { subject: "Change delivery address", description: "Please ship order #A-1131 to my office instead.", requester: "lucas.moreau@example.com", status: "Resolved", priority: "Medium", tags: ["shipping"] },
  { subject: "Return label request", description: "I'd like to return the blue scarf from order #A-1077.", requester: "diego.alvarez@example.com", status: "Closed", priority: "Low", tags: ["returns"] },
  { subject: "Warehouse stock count mismatch", description: "Our dashboard shows 40 units but the warehouse counted 32.", requester: "arjun.mehta@example.com", status: "Open", priority: "High", tags: ["inventory", "b2b"] },
  { subject: "Gift wrapping missing", description: "Paid for gift wrapping but the item came unwrapped.", requester: "priya.nair@example.com", status: "Resolved", priority: "Low", tags: ["vip"] },
  { subject: "Subscription cancellation", description: "Please cancel my coffee subscription from next month.", requester: "tomas.novak@example.com", status: "Pending", priority: "Medium", tags: ["subscription"] },
  { subject: "Payment link expired", description: "The payment link in my email says it has expired.", requester: "kwame.mensah@example.com", status: "Open", priority: "Medium", tags: ["payments"] },
  { subject: "Partial delivery received", description: "Only 3 of 5 items in order #A-1150 arrived.", requester: "hannah.okafor@example.com", status: "Open", priority: "High", tags: ["shipping"], notes: [{ body: "Remaining 2 items were split into a second shipment.", private: true }] },
  { subject: "Request for product care guide", description: "Do you have washing instructions for the linen range?", requester: "sofia.lindqvist@example.com", status: "Closed", priority: "Low", tags: ["product-info"] },
  { subject: "Chargeback notification", description: "We received a chargeback notice for order #A-0950.", requester: "aisha.rahman@example.com", status: "Pending", priority: "Urgent", tags: ["payments", "b2b"] },
];
