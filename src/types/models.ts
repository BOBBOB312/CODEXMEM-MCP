export type PendingMessageType = "observation" | "summarize";
export type PendingStatus = "pending" | "processing" | "processed" | "failed";

export interface PendingMessage {
  id: number;
  session_db_id: number;
  content_session_id: string;
  message_type: PendingMessageType;
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  last_assistant_message: string | null;
  prompt_number: number | null;
  status: PendingStatus;
  retry_count: number;
  created_at_epoch: number;
  started_processing_at_epoch: number | null;
  completed_at_epoch: number | null;
  failed_at_epoch: number | null;
}

export interface ObservationInput {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface SummaryInput {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}
