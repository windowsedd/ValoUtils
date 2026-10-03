import { invoke } from "@tauri-apps/api/core";

import CustomButton from "@/components/button";
import { useDynamicModal } from "@/components/dynamic-modal";
import { Button } from "@heroui/react";

function IPCTest() {
  const { showModal, closeModal } = useDynamicModal();
  return <>
    <h1 className="text-4xl font-bold text-center mt-4">Hello World</h1>
    <CustomButton onClickLoading={async () => {
      const message = await invoke("client_info_get");
      showModal({ title: "Message", body: JSON.stringify(message, null, 2), footer: <Button variant="danger" onPress={closeModal}>Close</Button> });
    }}>Send</CustomButton>
  </>;
}
export default IPCTest;
