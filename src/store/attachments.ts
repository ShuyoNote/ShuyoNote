import { create } from "zustand";

// Shared revision so the attachment panel reloads when files are imported from
// elsewhere (e.g. the `/附件` slash command), even while it's hidden (empty).
interface AttachmentsState {
  revision: number;
  bump: () => void;
}

export const useAttachmentsStore = create<AttachmentsState>((set) => ({
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));
