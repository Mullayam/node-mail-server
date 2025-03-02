export interface GenreateICSOptions {
    uid: string,
    method: "REQUEST" | "CANCEL",
    title: string,
    description: string,
    location: string,
    start: string,
    end: string,
    organizer: {
        name: string,
        email: string},
    attendees: string[],
    sequence: number 
}