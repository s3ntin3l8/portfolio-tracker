"use client";

import { useCallback, useState } from "react";
import { useApiCall } from "@/lib/use-api-call";

export function useCredentialDialog({
  onSave,
  onClear,
  errorMessage,
}: {
  onSave: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
  errorMessage: string;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [saveState, save] = useApiCall(
    useCallback(async () => {
      if (!apiKey.trim()) return;
      await onSave(apiKey.trim());
      setApiKey("");
      setDialogOpen(false);
    }, [apiKey, onSave]),
    { fallbackMessage: errorMessage },
  );

  const [clearState, clear] = useApiCall(
    useCallback(async () => {
      await onClear();
    }, [onClear]),
    { fallbackMessage: errorMessage },
  );

  const busy = saveState.busy || clearState.busy;
  const error = saveState.error || clearState.error;

  function handleDialogChange(open: boolean) {
    setDialogOpen(open);
    if (!open) {
      setApiKey("");
      setShowKey(false);
    }
  }

  return {
    dialogOpen,
    apiKey,
    setApiKey,
    showKey,
    setShowKey,
    busy,
    error,
    handleDialogChange,
    handleSave: save,
    handleClear: clear,
  };
}
