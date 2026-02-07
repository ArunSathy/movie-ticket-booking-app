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


// Create an empty array where we'll export future Inngest functions
export const functions = [syncUserCreation, syncUserDeletion, syncUserUpdation, releaseSeatsAndDeleteBooking, sendBookingConfirmationEmail];