import { google } from "googleapis";
import utils from "@/lib/helpers/utils";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

const oauth2Client = new google.auth.GoogleAuth({
    apiKey: "your_api_key",
    scopes: SCOPES,
})

const calendar = google.calendar({ version: "v3", auth: oauth2Client });
export class MeetingService {
    async createGoogleMeetEvent(title: string, description: string, startTime: string, endTime: string, attendees: string[]) {
        const event = {
            summary: title || "Team Meeting",
            description: description || "Discuss project updates",
            start: {
                dateTime: startTime,
                timeZone: "UTC",
            },
            end: {
                dateTime: endTime,
                timeZone: "UTC",
            },
            conferenceData: {
                createRequest: {
                    requestId: utils.uuid_v4(),
                    conferenceSolutionKey: { type: "hangoutsMeet" },
                },
            },
            attendees: attendees.map((email) => ({ email })),
        };
        const response = await calendar.events.insert({
            sendNotifications: true,
            calendarId: "primary",
            requestBody: event,
            conferenceDataVersion: 1,
        });

        return response.data.hangoutLink as string;
    }

}