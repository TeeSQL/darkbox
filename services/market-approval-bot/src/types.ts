export type ProposalPayload = {
  proposalId: string;
  agentId?: string;
  question: string;
  description?: string;
  outcomes?: string[];
  resolveBy?: string;
  resolutionSource?: string;
  rationale?: string;
  metadataURI?: string;
  runId?: string;
  turn?: number;
  closeTime?: number | string;
  expiry?: number | string;
  proposerKind?: string;
  proposerId?: string;
  proposerTelegramId?: string;
  proposerTelegramUsername?: string;
  proposerRole?: string;
};

export type TelegramMessage = {
  message_id: number;
  chat: { id: number | string };
  message_thread_id?: number;
  text?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage & {
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string; last_name?: string };
    message?: TelegramMessage;
    data?: string;
  };
};
