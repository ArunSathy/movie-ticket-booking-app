import { Inngest } from "inngest";
import User from "../models/User.js";
import Booking from "../models/Booking.js";
import Show from "../models/Show.js";
import sendEmail from "../configs/nodeMailer.js";

// Create a client to send and receive events
export const inngest = new Inngest({ id: "quick-show" });

// Inngest function to save user data to database
const syncUserCreation = inngest.createFunction(
    { id: "sync-user-from-clerk" },
    { event: "clerk/user.created" },
    async ({ event }) => {
        const { id, first_name, last_name, email_addresses, image_url } = event.data;
        const userData = {
            _id: id,
            email: email_addresses[0].email_address,
            name: `${first_name} ${last_name}`,
            image: image_url
        }
        await User.create(userData);
    }
)

// Inngest function to delete user data to database
const syncUserDeletion = inngest.createFunction(
    { id: "delete-user-from-clerk" },
    { event: "clerk/user.deleted" },
    async ({ event }) => {
        const { id } = event.data;
        await User.findByIdAndDelete(id);
    }
)

// Inngest function to update user data to database
const syncUserUpdation = inngest.createFunction(
    { id: "update-user-from-clerk" },
    { event: "clerk/user.updated" },
    async ({ event }) => {
        const { id, first_name, last_name, email_addresses, image_url } = event.data;
        const userData = {
            _id: id,
            email: email_addresses[0].email_address,
            name: `${first_name} ${last_name}`,
            image: image_url
        }
        await User.findByIdAndUpdate(id, userData);
    }
)

// Inngest function to cancel booking and release seats of show after 10 minutes of booking created if payment if not made
const releaseSeatsAndDeleteBooking = inngest.createFunction(
    {id: 'release-seats-delete-booking'},
    {event: 'app/checkpayment'},
    async ({event, step}) => {
        const tenMinutesLater = new Date(Date.now() + 10 * 60 * 1000);
        await step.sleepUntil('wait-for-10-minutes', tenMinutesLater);

        await step.run('check-payment-status', async () => {
            const bookingId = event.data.bookingId;
            const booking = await Booking.findById(bookingId);
            
            // if payment if not made, release seats and delete booking
            if (!booking.isPaid){
                const show = await Show.findById(booking.show);
                booking.bookedSeats.forEach((seat) => {
                    delete show.occupiedSeats[seat]
                });
                show.markModified('occupiedSeats')
                await show.save();
                await Booking.findByIdAndDelete(booking._id);
            } 
        })
        
    }
)

// Inngest function to send email when user books a show
const sendBookingConfirmationEmail = inngest.createFunction(
    {id: 'send-booking-confirmation-email'},
    {event: 'app/show.booked'},
    async ({event, step}) => { 
        const {bookingId} = event.data;
        const booking = await Booking.findById(bookingId).populate({
            path: 'show',
            populate: {
                path: 'movie',
                model: 'Movie'
            }
        }).populate('user');   

        await sendEmail({
            to: booking.user.email,
            subject: `Payment Confirmation : "${booking.show.movie.title}" booked!`,
            body: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                <h1 style="color: #22c55e;">Booking Confirmed!</h1>
                <h2 style="color: #22c55e;">Hi ${booking.user.name}</h2>
                <p>Thank you for booking your tickets with QuickShow. Here are your details:</p>
                
                <div style="margin: 20px 0; padding: 15px; background-color: #f9f9f9; border-radius: 6px;">
                    <h3 style="margin-top: 0;">${booking.show.movie.title}</h3>
                    <p><strong>Date:</strong> ${new Date(booking.show.showDateTime).toLocaleDateString('en-US', {timeZone: 'Asia/Kolkata'})}</p>
                    <p><strong>Time:</strong> ${new Date(booking.show.showDateTime).toLocaleTimeString('en-US', {timeZone: 'Asia/Kolkata'})}</p>
                    <p><strong>Seats:</strong> ${booking.bookedSeats.join(', ')}</p>
                    <p><strong>Total Amount:</strong> ₹${booking.amount}</p> 
                </div>
                
                <p>We look forward to seeing you at the cinema!</p>
                <p>Best regards,<br>QuickShow Team</p>
            </div>
            `
            
        })
        
    }
)

// Inngest funtion to send reminder
const sendShowReminders = inngest.createFunction(
    {id: 'send-show-reminders'},
    {cron: "0 */8 * * *"}, // every 8 hours
    async ({step}) => {
        const now = new Date();
        const in8Hours = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const windowStart = new Date(in8Hours.getTime() - 10 * 60 * 1000);

        //prepare reminder tasks
        const reminderTasks = await step.run('prepare-reminder-tasks', async () => {
            const shows = await Show.find({
                showTime: {
                    $gte: windowStart,
                    $lte: in8Hours
                }
            }).populate('movie');

            const tasks = [];

            for(const show of shows){
                if(!show.movie || !show.occupiedSeats) continue;

                const userIds = [...new Set(Object.values(show.occupiedSeats))]
                if(userIds.length === 0) continue;

                const users = await User.find({ _id: { $in: userIds } }).select("name email");

                for(const user of users){
                    tasks.push({
                        userEmail: user.email,
                        userName: user.name,
                        movieTitle: show.movie.title,
                        showTime: show.showTime,
                        showDate: show.showDate,
                        seats: show.occupiedSeats
                    })
                }
            }
            return tasks;
        })

        if(reminderTasks.length === 0){
            return {sent: 0, message: 'No reminders to send'}
        }

        //send reminders emails

        const result = await step.run('send-all-reminders', async () => {
            return await Promise.allSettled(
                reminderTasks.map(task => sendEmail({
                    to: task.userEmail,
                    subject: `Reminder: Your Show "${task.movieTitle}" starts soon!`,
                    body: `
                    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                        <h1 style="color: #22c55e;">Reminder: Your Show "${task.movieTitle}" starts soon!</h1>
                        <h2 style="color: #22c55e;">Hi ${task.userName}</h2>
                        <p>Here are your show details:</p>
                        
                        <div style="margin: 20px 0; padding: 15px; background-color: #f9f9f9; border-radius: 6px;">
                            <h3 style="margin-top: 0;">${task.movieTitle}</h3>
                            <p><strong>Date:</strong> ${new Date(task.showDate).toLocaleDateString('en-US', {timeZone: 'Asia/Kolkata'})}</p>
                            <p><strong>Time:</strong> ${new Date(task.showTime).toLocaleTimeString('en-US', {timeZone: 'Asia/Kolkata'})}</p>
                            <p><strong>Seats:</strong> ${task.seats.join(', ')}</p>
                        </div>
                        
                        <p>Don't miss out to watch your favorite movie!</p>
                        <p>Best regards,<br>QuickShow Team</p>
                    </div>
                    `
                }))
            )
        })

        const sent = result.filter(r => r.status === 'fulfilled').length;
        const failed = result.length - sent;
        return {sent, failed,
            message: `Sent ${sent} reminders and failed to send ${failed} reminders`
        };
        
    }
)

// Inngest funtion to send notification when a new show is added
const sendNewShowNotifications = inngest.createFunction(
    {id: "send-new-show-notification"},
    {event: "app/show.added"},
    async ({event}) => {
        const { movieTitle } = event.data;

        const users = await User.find({})

        for(const user of users){
            const userEmail = user.email;
            const userName = user.name;

            const subject = `🎬 New Show Added : "${movieTitle}"`;
            const body = `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                <h1 style="color: #22c55e;">New Show Added!</h1>
                <h2 style="color: #22c55e;">Hi ${userName}</h2>
                <p>A new show has been added to QuickShow:</p>
                
                <div style="margin: 20px 0; padding: 15px; background-color: #f9f9f9; border-radius: 6px;">
                    <h3 style="margin-top: 0;">${movieTitle}</h3>
                    <p>Check out the latest shows and book your tickets now!</p>
                </div>
                <p>Best regards,<br>QuickShow Team</p>
            </div>
            `
            await sendEmail({
                to: userEmail,
                subject,
                body
            })

        }

        return {message: "Notification sent"}

    }
)



// Create an empty array where we'll export future Inngest functions
export const functions = [syncUserCreation, syncUserDeletion, syncUserUpdation, releaseSeatsAndDeleteBooking, sendBookingConfirmationEmail, sendShowReminders, sendNewShowNotifications];