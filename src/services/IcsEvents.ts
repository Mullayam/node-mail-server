
import moment from 'moment';

import * as ics from 'ics'
import { MeetingService } from './MeetingService';
import { GenreateICSOptions } from '@/types/ics.interface';

const meetServiceLink = new MeetingService()
export default class IcalService {
    public static async createEvent(data: GenreateICSOptions) {
        const startMoment = moment(data.start);
        const endMoment = moment(data.end);
        let start = startMoment.format('YYYY-M-D-H-m').split("-").map((a) => parseInt(a)) as ics.DateArray
        let end = endMoment.add().format("YYYY-M-D-H-m").split("-").map((a) => parseInt(a)) as ics.DateArray
        const duration = moment.duration(endMoment.diff(startMoment))

        const url = await meetServiceLink.createGoogleMeetEvent(data.title, data.description, data.start, data.end, data.attendees)
        const attendeeStr = data.attendees.map((email) => ({ email, rsvp: true, role: 'REQ-PARTICIPANT' })) as ics.Attendee[]

        const event: ics.EventAttributes = {
            start,
            end,
            duration: {
                hours: Math.floor(duration.asHours()),
                minutes: duration.minutes(),
            },
            title: data.title,
            description: data.description,
            // location: 'Folsom Field, University of Colorado (finish line)',
            url,
            status: 'CONFIRMED',
            busyStatus: 'FREE',
            organizer: data.organizer,
            attendees: attendeeStr
        }
        return ics.createEvent(event);

    }
}