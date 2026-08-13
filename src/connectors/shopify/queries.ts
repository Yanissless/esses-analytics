/** GraphQL query strings for the Shopify Admin API. */

export const ORDERS_QUERY = /* GraphQL */ `
  query Orders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys) {
    orders(first: $first, after: $after, query: $query, sortKey: $sortKey) {
      pageInfo { hasNextPage endCursor }
      edges {
        cursor
        node {
          id
          name
          processedAt
          createdAt
          updatedAt
          cancelledAt
          test
          tags
          displayFinancialStatus
          displayFulfillmentStatus
          sourceName
          app { name }
          paymentGatewayNames
          currencyCode
          presentmentCurrencyCode
          # Promo identity. We stored discount AMOUNTS but never the code, so
          # "did this promo attract worse subscribers?" was unanswerable. Note the
          # set includes operational adjustments ("Delivery Issue", "Custom
          # discount") alongside real promos — see isMarketingPromo().
          discountCodes
          # Destination drives VAT, shipping zone and fulfilment origin. Without
          # these the market_config join finds nothing, so every order falls back
          # to zone 'row' / VAT 0 and the US-scoped shipping rate rules can never
          # match. Readable on the current token — no extra scope needed.
          shippingAddress { countryCodeV2 }
          billingAddress { countryCodeV2 }
          subtotalPriceSet { shopMoney { amount currencyCode } }
          totalPriceSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          totalReceivedSet { shopMoney { amount currencyCode } }
          totalDiscountsSet { shopMoney { amount currencyCode } }
          totalShippingPriceSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
          totalRefundedSet { shopMoney { amount currencyCode } }
          customer { id email firstName lastName phone }
          lineItems(first: 100) {
            edges {
              node {
                id
                sku
                title
                variantTitle
                quantity
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                discountedUnitPriceSet { shopMoney { amount currencyCode } }
                sellingPlan { name sellingPlanId }
                variant { id sku }
              }
            }
          }
          # Attribution carried on the ORDER itself, set by esses.com at checkout.
          #
          # This is the only route that can work for this business. Ads point at esses.com
          # (Craft), checkout happens in Shopify, and Shopify's analytics only observe pages
          # Shopify serves — so customerJourneySummary below records the checkout and nothing
          # before it. Measured over 30 recent orders: zero carried a UTM anywhere, and every
          # landingPageUrl was a checkout URL.
          #
          # Cart attributes survive that handoff because they travel with the cart rather
          # than being inferred from a page view. See docs/esses-com-attribution.md.
          customAttributes { key value }
          customerJourneySummary {
            ready
            daysToConversion
            customerOrderIndex
            firstVisit {
              occurredAt source sourceType referrerUrl landingPage
              utmParameters { source medium campaign content term }
            }
            lastVisit {
              occurredAt source sourceType referrerUrl landingPage
              utmParameters { source medium campaign content term }
            }
            moments(first: 20) {
              edges {
                node {
                  occurredAt
                  ... on CustomerVisit {
                    source sourceType referrerUrl landingPage
                    utmParameters { source medium campaign content term }
                  }
                }
              }
            }
          }
          refunds {
            id
            createdAt
            totalRefundedSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  }
`;

export const PRODUCTS_QUERY = /* GraphQL */ `
  query Products($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        cursor
        node {
          id
          title
          handle
          productType
          vendor
          status
          variants(first: 100) {
            edges {
              node { id sku title price }
            }
          }
        }
      }
    }
  }
`;

export const CUSTOMERS_QUERY = /* GraphQL */ `
  query Customers($first: Int!, $after: String, $query: String, $sortKey: CustomerSortKeys) {
    customers(first: $first, after: $after, query: $query, sortKey: $sortKey) {
      pageInfo { hasNextPage endCursor }
      edges {
        cursor
        node {
          id
          email
          firstName
          lastName
          phone
          createdAt
          updatedAt
        }
      }
    }
  }
`;
