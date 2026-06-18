import axios from "axios";

const baseUrl = "https://api.pastes.dev/";

export const getData = async (id: string) => {
    const res = await axios.get(baseUrl + id);
    return res.data as string;
}
export const saveData = async (data: string) => {
    const res = await axios.post(baseUrl + "post", data);
    return res.data.key as string;
}