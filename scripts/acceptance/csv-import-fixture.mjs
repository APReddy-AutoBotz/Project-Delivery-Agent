// FR-CON-006/007: fixed synthetic input; input-only values must not be stored.
export const csvImportFixture = Object.freeze({
  fileName: "native-import.csv",
  csv:
    "Issue ID,Project ID,Forecast,Private\n" +
    "DELIVERY-1,30000000-0000-4000-8000-000000000003,2027-03-01,csv-private-one\n" +
    "DELIVERY-2,30000000-0000-4000-8000-000000000003,not-a-date,csv-private-two\n" +
    "DELIVERY-3,30000000-0000-4000-8000-000000000003,2027-04-15,csv-private-three\n",
  csvSha256: "afe67ec40ec6dd1dfa8cf1b5cd5d1772eab83d9df0ddc4fc5aa1d01994af1da3",
  // Independently calculated from the complete fixed header/value pairs.
  rowSourceHashes: Object.freeze({
    1: "753534802846503d31397345e9f127bff4f3857cfda225c5be401fcd71a1f640",
    2: "53a017a84b3d387663e9de2e6dfae93579abad546148aae8d3d0fb6abf4dcc07",
    3: "180cfdf36864a38a8ef56fa1474c8ef7bda9687cf65cb3ea25cf38026230b24c",
  }),
});
