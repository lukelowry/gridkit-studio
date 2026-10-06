/** Shared query and numerical-analysis schemas. */
export const queryFields = {
  "where": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "field": {
          "type": "string",
          "minLength": 1
        },
        "operator": {
          "type": "string",
          "enum": [
            "equal",
            "notEqual",
            "lessThan",
            "lessThanOrEqual",
            "greaterThan",
            "greaterThanOrEqual",
            "contains"
          ]
        },
        "value": {
          "type": [
            "string",
            "number",
            "boolean",
            "null"
          ]
        }
      },
      "required": [
        "field",
        "operator",
        "value"
      ],
      "additionalProperties": false
    },
    "minItems": 1,
    "uniqueItems": true
  },
  "orderBy": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "field": {
          "type": "string",
          "minLength": 1
        },
        "direction": {
          "type": "string",
          "enum": [
            "ascending",
            "descending"
          ]
        }
      },
      "required": [
        "field",
        "direction"
      ],
      "additionalProperties": false
    },
    "minItems": 1,
    "uniqueItems": true
  },
  "metrics": {
    "type": "array",
    "items": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "extrema"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "initial-final"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "threshold"
            },
            "lower": {
              "type": "number"
            },
            "upper": {
              "type": "number"
            },
            "durationMethod": {
              "const": "left-hold"
            },
            "maxGapSeconds": {
              "type": "number",
              "exclusiveMinimum": 0
            }
          },
          "required": [
            "kind",
            "durationMethod",
            "maxGapSeconds"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "const": "settling"
            },
            "after": {
              "type": "number"
            },
            "band": {
              "type": "array",
              "items": {
                "type": "number"
              },
              "minItems": 2,
              "maxItems": 2
            },
            "holdSeconds": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxGapSeconds": {
              "type": "number",
              "exclusiveMinimum": 0
            }
          },
          "required": [
            "kind",
            "after",
            "band",
            "holdSeconds",
            "maxGapSeconds"
          ],
          "additionalProperties": false
        }
      ]
    },
    "minItems": 1,
    "uniqueItems": true
  },
  "representation": {
    "oneOf": [
      {
        "type": "object",
        "properties": {
          "kind": {
            "const": "exact"
          },
          "maxSamples": {
            "type": "integer",
            "minimum": 1
          },
          "offset": {
            "type": "integer",
            "minimum": 0
          }
        },
        "required": [
          "kind",
          "maxSamples"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "kind": {
            "const": "envelope"
          },
          "buckets": {
            "type": "integer",
            "minimum": 1
          }
        },
        "required": [
          "kind",
          "buckets"
        ],
        "additionalProperties": false
      }
    ]
  }
}
