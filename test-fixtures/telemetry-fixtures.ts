export const toolDefinitionsFixture = [
  {
    type: "function",
    name: "search_policy",
    description: "Searches policy documents for matching snippets",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
];

export const toolRequestFixture = {
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is the parental leave policy?" },
  ],
  tools: toolDefinitionsFixture,
};

export const toolResponseFixture = {
  choices: [
    {
      message: {
        role: "assistant",
        content: "I will search the policy docs.",
      },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 8,
    total_tokens: 20,
  },
};

/** OpenAI Responses API fixture (non-streaming successful response) */
export const openaiResponsesFixture = {
  id: "resp_xxx",
  object: "response",
  status: "completed",
  model: "gpt-4o",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello!" }],
    },
  ],
  output_text: "Hello!",
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

/** OpenAI Responses API fixture (failed response) */
export const openaiResponsesFailedFixture = {
  id: "resp_failed",
  object: "response",
  status: "failed",
  error: {
    code: "server_error",
    message: "The model failed to generate a response.",
  },
  output: [],
  usage: null,
};

/** OpenAI Responses API fixture (incomplete - max_tokens) */
export const openaiResponsesIncompleteFixture = {
  id: "resp_incomplete",
  object: "response",
  status: "incomplete",
  incomplete_details: { reason: "max_tokens" },
  output: [],
  usage: { input_tokens: 100, output_tokens: 500, total_tokens: 600 },
};

export const agenticLoopFixture = {
  thoughtSummary: "Search the policy docs and summarize the result.",
  toolCall: {
    toolName: "search_policy",
    args: { query: "parental leave policy" },
    result: {
      snippets: [
        "Parental leave is 16 weeks for primary caregiver.",
        "Secondary caregiver leave is 6 weeks.",
      ],
    },
  },
  followupResponse: {
    choices: [
      {
        message: {
          role: "assistant",
          content:
            "Primary caregivers receive 16 weeks; secondary caregivers receive 6 weeks.",
        },
        finish_reason: "stop",
      },
    ],
  },
};
