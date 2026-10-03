import { listenEvent } from "@/util/ipc";
import { isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { Toast } from "@heroui/react";

type AlertContainerProps = {
    children: React.ReactNode | React.ReactNode[];
}
const AlertContainer = (props: AlertContainerProps) => {
    useEffect(() => {
        const onError = (event: Event) => Toast.toast.danger((event as CustomEvent<string>).detail);
        window.addEventListener("valoutils:ipc-error", onError);
        const stop = isTauri() ? listenEvent<string>("alert:info", message => Toast.toast.info(message)) : () => {};
        return () => { stop(); window.removeEventListener("valoutils:ipc-error", onError); };
    }, []);
    return (
        <>
            {props.children}
        </>
    );
};

export default AlertContainer;
