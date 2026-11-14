import React, { createContext, ReactNode, useContext, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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
	showModal: () => {},
	closeModal: () => {},
});

export const useDynamicModal = (): DynamicModalContextProps => useContext(DynamicModalContext);

/** One app-wide modal (shadcn/ui Dialog) that pages fill through `showModal`. */
export const DynamicModalProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
	const [modalContent, setModalContent] = useState<ModalContentProps | null>(null);
	const [props, setProps] = useState<ModalContentProps | null>(null);

	const showModal = (content: ModalContentProps) => {
		setProps(content);
		setModalContent(content);
	};

	const closeModal = () => {
		setModalContent(null);
		if (props) {
			props.onClose?.();
			setProps(null);
		}
	};

	return (
		<DynamicModalContext.Provider value={{ showModal, closeModal }}>
			{children}
			<Dialog
				open={modalContent !== null}
				onOpenChange={(open) => {
					if (!open) closeModal();
				}}
			>
				{modalContent && (
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{modalContent.title}</DialogTitle>
							{/* Radix wants a description; the body carries the real content. */}
							<DialogDescription className="sr-only">{modalContent.title}</DialogDescription>
						</DialogHeader>
						<div data-slot="dialog-body" className="min-h-0 flex-1 overflow-y-auto">
							{modalContent.body}
						</div>
						<DialogFooter>{modalContent.footer}</DialogFooter>
					</DialogContent>
				)}
			</Dialog>
		</DynamicModalContext.Provider>
	);
};
