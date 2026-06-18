import React, { createContext, ReactNode, useContext, useState } from "react";
import { Modal, useOverlayState } from "@heroui/react";

interface ModalContentProps {
    title: string;
    body: React.ReactNode | React.ReactNode[];
    footer: React.ReactNode | React.ReactNode[];
    onClose?: () => void;
}

interface DynamicModalContextProps {
    showModal: (content: ModalContentProps) => void;
    closeModal: () => void;
}

const DynamicModalContext = createContext<DynamicModalContextProps>({
    showModal: () => {
    },
    closeModal: () => {
    }
});

export const useDynamicModal = (): DynamicModalContextProps => useContext(DynamicModalContext);

export const DynamicModalProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [modalContent, setModalContent] = useState<ModalContentProps | null>(null);
    const [props, setProps] = useState<ModalContentProps | null>(null);

    const showModal = (content: ModalContentProps) => {
        setProps(content)
        setModalContent(content);
    };

    const closeModal = () => {
        setModalContent(null);
        if (props) {
            if (props.onClose) {
                props.onClose();
            }
            setProps(null);
        }
    };

    // HeroUI v3 controls overlays via an overlay-state object instead of the
    // `isOpen`/`onOpenChange` props that NextUI v2 used directly on <Modal>.
    const state = useOverlayState({
        isOpen: modalContent !== null,
        onOpenChange: (open) => {
            if (!open) {
                closeModal();
            }
        },
    });

    return (
        <DynamicModalContext.Provider value={{ showModal, closeModal }}>
            {children}
            {modalContent && (
                <Modal state={state}>
                    <Modal.Backdrop>
                        <Modal.Container>
                            <Modal.Dialog className="w-170 max-w-[92vw]">
                                <Modal.Header className="flex flex-col gap-1">
                                    <Modal.Heading>{modalContent.title}</Modal.Heading>
                                </Modal.Header>
                                <Modal.Body>{modalContent.body}</Modal.Body>
                                <Modal.Footer>{modalContent.footer}</Modal.Footer>
                            </Modal.Dialog>
                        </Modal.Container>
                    </Modal.Backdrop>
                </Modal>
            )}
        </DynamicModalContext.Provider>
    );
};
