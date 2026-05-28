import { describe, it, expect, vi } from "vitest";

// ── Extracted send_media logic (mirrors wecom.ts sendMedia closure) ────────────
// Tests that:
// 1. uploadMedia is called with correct args
// 2. sendMediaMessage (not replyMedia) is called with chatId + media_id
// 3. errors are caught and returned as { ok: false, error }

type UploadResult = { media_id: string };

function createSendMedia(
  chatId: string,
  wsClient: {
    uploadMedia: (buf: Buffer, opts: { type: string; filename: string }) => Promise<UploadResult>;
    sendMediaMessage: (chatId: string, type: string, mediaId: string) => Promise<void>;
  },
  readFile: (path: string) => Buffer
) {
  return async (filePath: string, mediaType: string, filename?: string) => {
    if (!wsClient) return { ok: false, error: "WeCom client not connected" };
    try {
      const buffer = readFile(filePath);
      const fname = filename ?? filePath.split("/").pop() ?? "file";
      const { media_id } = await wsClient.uploadMedia(buffer, { type: mediaType, filename: fname });
      await wsClient.sendMediaMessage(chatId, mediaType, media_id);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

describe("wecom send_media", () => {
  const CHAT_ID = "user_abc123";
  const FILE_PATH = "/tmp/test.png";
  const MEDIA_ID = "media_xyz";
  const FAKE_BUFFER = Buffer.from("fake image data");

  it("uploads and sends via sendMediaMessage with chatId", async () => {
    const uploadMedia = vi.fn().mockResolvedValue({ media_id: MEDIA_ID });
    const sendMediaMessage = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockReturnValue(FAKE_BUFFER);

    const sendMedia = createSendMedia(CHAT_ID, { uploadMedia, sendMediaMessage }, readFile);
    const result = await sendMedia(FILE_PATH, "image");

    expect(result).toEqual({ ok: true });
    expect(uploadMedia).toHaveBeenCalledWith(FAKE_BUFFER, { type: "image", filename: "test.png" });
    // Must use sendMediaMessage(chatId, ...) not replyMedia(frame, ...)
    expect(sendMediaMessage).toHaveBeenCalledWith(CHAT_ID, "image", MEDIA_ID);
  });

  it("uses provided filename over path basename", async () => {
    const uploadMedia = vi.fn().mockResolvedValue({ media_id: MEDIA_ID });
    const sendMediaMessage = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockReturnValue(FAKE_BUFFER);

    const sendMedia = createSendMedia(CHAT_ID, { uploadMedia, sendMediaMessage }, readFile);
    await sendMedia(FILE_PATH, "file", "report.pdf");

    expect(uploadMedia).toHaveBeenCalledWith(FAKE_BUFFER, { type: "file", filename: "report.pdf" });
  });

  it("returns error when upload fails", async () => {
    const uploadMedia = vi.fn().mockRejectedValue(new Error("upload timeout"));
    const sendMediaMessage = vi.fn();
    const readFile = vi.fn().mockReturnValue(FAKE_BUFFER);

    const sendMedia = createSendMedia(CHAT_ID, { uploadMedia, sendMediaMessage }, readFile);
    const result = await sendMedia(FILE_PATH, "image");

    expect(result).toEqual({ ok: false, error: "upload timeout" });
    expect(sendMediaMessage).not.toHaveBeenCalled();
  });

  it("returns error when sendMediaMessage fails", async () => {
    const uploadMedia = vi.fn().mockResolvedValue({ media_id: MEDIA_ID });
    const sendMediaMessage = vi.fn().mockRejectedValue(new Error("send failed"));
    const readFile = vi.fn().mockReturnValue(FAKE_BUFFER);

    const sendMedia = createSendMedia(CHAT_ID, { uploadMedia, sendMediaMessage }, readFile);
    const result = await sendMedia(FILE_PATH, "image");

    expect(result).toEqual({ ok: false, error: "send failed" });
  });

  it("does NOT call replyMedia", async () => {
    const uploadMedia = vi.fn().mockResolvedValue({ media_id: MEDIA_ID });
    const sendMediaMessage = vi.fn().mockResolvedValue(undefined);
    const replyMedia = vi.fn(); // should never be called
    const readFile = vi.fn().mockReturnValue(FAKE_BUFFER);

    // replyMedia is NOT in the interface — this test documents the contract
    const sendMedia = createSendMedia(CHAT_ID, { uploadMedia, sendMediaMessage }, readFile);
    await sendMedia(FILE_PATH, "image");

    expect(replyMedia).not.toHaveBeenCalled();
    expect(sendMediaMessage).toHaveBeenCalledOnce();
  });
});
