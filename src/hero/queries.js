// Query-Bausteine fuer die Hero API v9.
// Feldnamen wurden per Introspection gegen die echte API verifiziert (nicht geraten).

export const PROJECT_MATCHES_QUERY = (first, offset) => `{
  project_matches(first: ${first}, offset: ${offset}) {
    id
    display_id
    name
    volume
    current_project_match_status_id
    current_project_match_status {
      id
      name
    }
    customer {
      id
      nr
      type
      first_name
      last_name
      company_name
      email
    }
    created
    modified
  }
}`;

export const CUSTOMER_DOCUMENTS_QUERY = (first, offset) => `{
  customer_documents(first: ${first}, offset: ${offset}) {
    nr
    type
    status_code
    status_name
    date
    value
    vat
    project_match_id
    created
    modified
    customer_document_booking {
      is_open
      due_date
      paid_date
      balance
      status_name
    }
    published_customer_document_draft {
      id
      name
      type
      data
    }
  }
}`;

// WageGroup_WageGroups und Receipt_Receipts sind Relay-Connections (edges/node).
export const WAGE_GROUPS_QUERY = (first, offset) => `{
  WageGroup_WageGroups(first: ${first}, offset: ${offset}) {
    edges {
      node {
        id
        name
        wageCostPrice
        wagePerHour
      }
    }
  }
}`;

export const RECEIPTS_QUERY = (first, offset) => `{
  Receipt_Receipts(first: ${first}, offset: ${offset}) {
    edges {
      node {
        id
        receiptDate
        value
        netValue
        statedTotalVat
        dueDate
        paidDate
        openAmount
        tax {
          name
          buKey
        }
      }
    }
  }
}`;

// tracking_times wird in Zeitfenstern abgefragt (Hero deckelt Ergebnisse bei ca. 2000).
export const TRACKING_TIMES_QUERY = (start, end, first, offset) => `{
  tracking_times(start: "${start}", end: "${end}", show_all_partners: true, first: ${first}, offset: ${offset}) {
    uuid
    start
    end
    project_match_id
    tracking_times_category_id
    comment
    created
    modified
  }
}`;
