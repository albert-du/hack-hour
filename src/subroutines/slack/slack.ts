import { app } from "../../lib/bolt.js";
import { Commands, Environment } from "../../lib/constants.js";
import { prisma, uid } from "../../lib/prisma.js";
import { emitter } from "../../lib/emitter.js";
import { t, t_fetch } from "./lib/templates.js";

import { updateController, updateTopLevel, cancelSession, informUser } from "./lib/lib.js";

import { Session } from "@prisma/client";

import "./functions/pause.js";
import "./functions/cancel.js";
import "./functions/extend.js";
import "./functions/goals.js";

/*
Session Creation
*/

/*
app.event("message", async ({ event }) => {
    try {
        const { subtype, channel, ts } = event;
        const thread_ts = (event as any).thread_ts
        const slackId = (event as any).user;

        if (thread_ts || channel != Environment.MAIN_CHANNEL) {
            return;
        }

        if (subtype && subtype != 'file_share') {
            return;
        }

        let slackUser = await prisma.slackUser.findUnique(
            {
                where: {
                    slackId,
                }
            }
        );

        if (!slackUser) {
            const slackUserData = await app.client.users.info({
                user: slackId
            });

            if (!slackUserData.user) {
                throw new Error(`Could not find user ${slackId}!`)
            } else if (!slackUserData.user.tz_offset) {
                throw new Error(`Could not retrieve timezone of ${slackId}`)
            }

            slackUser = await prisma.slackUser.create(
                {
                    data: {
                        slackId,
                        user: {
                            create: {
                                id: uid(),
                                lifetimeMinutes: 0,
                                apiKey: uid(),
                                goals: {
                                    create: {
                                        id: uid(),
                                        
                                        name: "No Goal",
                                        description: "A default goal for users who have not set one.",
                                      
                                        totalMinutes: 0,
                                        createdAt: new Date(),
                                      
                                        selected: true
                                    }
                                }
                            }
                        },
                        tz_offset: slackUserData.user.tz_offset
                    }
                }
            );        
        }

        // Cancel any existing sessions
        const existingSession = await prisma.session.findFirst({
            where: {
                userId: slackUser.userId,
                completed: false,
                cancelled: false
            }
        });

        if (existingSession) {
            await cancelSession(slackId, existingSession);
        }

        const user = await prisma.user.findUnique(
            {
                where: {
                    id: slackUser.userId
                }
            }
        );

        if (!user) {
            throw new Error(`User ${slackUser.userId} not found!`)
        }

        // Create a controller message in the thread
        const controller = await app.client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: "Initalizing..." // Leave it empty, for initialization
        })

        if (!controller || !controller.ts) {
            throw new Error(`Failed to create a message for ${slackId}`)
        }

        const session = await prisma.session.create({
            data: {
                userId: user.id,
                messageTs: ts,
                controlTs: controller.ts,
                
                createdAt: new Date(),
                time: 60,
                elapsed: 0,
              
                completed: false,
                cancelled : false,
                paused: false,

                elapsedSincePause: 0
            }
        });

        await updateController(session);
    } catch (error) {
        emitter.emit('error', error);
    }
});
*/

// Default command to start a session
app.command(Commands.HACK, async ({ command, ack, respond }) => {
    const slackId = command.user_id;

    if (!command.text || command.text.length == 0) {
        await ack({
            response_type: 'ephemeral',
            text: "Please provide a description of what you're working on."
        });

        return;
    }

    await ack();

    let slackUser = await prisma.slackUser.findUnique(
        {
            where: {
                slackId,
            }
        }
    );

    if (!slackUser) {
        const slackUserData = await app.client.users.info({
            user: slackId
        });

        if (!slackUserData.user) {
            throw new Error(`Could not find user ${slackId}!`)
        } else if (!slackUserData.user.tz_offset) {
            throw new Error(`Could not retrieve timezone of ${slackId}`)
        }

        slackUser = await prisma.slackUser.create(
            {
                data: {
                    slackId,
                    user: {
                        create: {
                            id: uid(),
                            lifetimeMinutes: 0,
                            apiKey: uid(),
                            goals: {
                                create: {
                                    id: uid(),

                                    name: "No Goal",
                                    description: "A default goal for users who have not set one.",

                                    totalMinutes: 0,
                                    createdAt: new Date(),

                                    selected: true
                                }
                            }
                        }
                    },
                    tz_offset: slackUserData.user.tz_offset
                }
            }
        );
    }

    const existingSession = await prisma.session.findFirst({
        where: {
            userId: slackUser.userId,
            completed: false,
            cancelled: false
        }
    });

    if (existingSession) {
        await informUser(slackId, "You already have an active session. Please cancel it before starting a new one.", command.channel_id);
        return;
    }

    const topLevel = await app.client.chat.postMessage({
        channel: command.channel_id,
        text: "Initalizing... :spin-loading:" // Leave it empty, for initialization
    });

    if (!topLevel || !topLevel.ts) {
        throw new Error(`Failed to create a message for ${slackId}`)
    }

    const user = await prisma.user.findUnique(
        {
            where: {
                id: slackUser.userId
            }
        }
    );

    if (!user) {
        throw new Error(`User ${slackUser.userId} not found!`)
    }

    // Create a controller message in the thread
    const controller = await app.client.chat.postMessage({
        channel: Environment.MAIN_CHANNEL,
        thread_ts: topLevel.ts,
        text: "Initalizing... :spin-loading:" // Leave it empty, for initialization
    })

    if (!controller || !controller.ts) {
        throw new Error(`Failed to create a message for ${slackId}`)
    }

    const session = await prisma.session.create({
        data: {
            userId: user.id,
            messageTs: topLevel.ts,
            controlTs: controller.ts,

            createdAt: new Date(),
            time: 60,
            elapsed: 0,

            completed: false,
            cancelled: false,
            paused: false,

            elapsedSincePause: 0,

            metadata: {
                toplevel: true,
                toplevel_template: t_fetch('toplevel'),
                work: command.text
            }
        }
    });

    await updateController(session);
    await updateTopLevel(session);

    emitter.emit('start', session);
});

/*
Minute tracker
*/
emitter.on('sessionUpdate', async (session: Session) => {
    try {
        // Check if the prisma user has a slack component
        const slackUser = await prisma.slackUser.findUnique({
            where: {
                userId: session.userId
            }
        });

        if (!slackUser) {
//            throw new Error(`Missing slack component of ${session.userId}`)
            return;
        }

        // Check if the message exists
        const message = await app.client.conversations.history({
            channel: Environment.MAIN_CHANNEL,
            latest: session.messageTs,
            limit: 1
        });

        if (message.messages == undefined || message.messages.length == 0) {
            console.log(`❌ Session ${session.messageTs} does not exist`);

            // Remove the session
            await prisma.session.delete({
                where: {
                    messageTs: session.messageTs
                }
            });

            return;
        }

        if (session.paused) {
            await updateController(session);

            return;
        } else if ((session.time - session.elapsed) % 15 == 0 && session.elapsed > 0) {
            // Send a reminder every 15 minutes
            await app.client.chat.postMessage({
                thread_ts: session.messageTs,
                channel: Environment.MAIN_CHANNEL,
                text: t(`update`, {
                    slackId: slackUser.slackId,
                    minutes: session.time - session.elapsed
                })
            });
        }

        await updateController(session);
        await updateTopLevel(session);
    } catch (error) {
        emitter.emit('error', error);
    }
});

emitter.on('complete', async (session: Session) => {
    const slackUser = await prisma.slackUser.findUnique({
        where: {
            userId: session.userId
        }
    });

    if (!slackUser) {
        // Skip
        return;
    }

    await app.client.chat.postMessage({
        thread_ts: session.messageTs,
        channel: Environment.MAIN_CHANNEL,
        text: t('complete', {
            slackId: slackUser.slackId
        })
    });

    await updateController(session);
    await updateTopLevel(session);

    await app.client.reactions.add({
        name: "tada",
        channel: Environment.MAIN_CHANNEL,
        timestamp: session.messageTs
    });

    return;
});

emitter.on('cancel', async (session: Session) => {
    const slackUser = await prisma.slackUser.findUnique({
        where: {
            userId: session.userId
        }
    });

    if (!slackUser) {
        // Skip
        return;
    }

    await app.client.chat.postMessage({
        thread_ts: session.messageTs,
        channel: Environment.MAIN_CHANNEL,
        text: t(`cancel`, {
            slackId: slackUser.slackId
        })
    });

    await updateController(session);
    await updateTopLevel(session);
});

emitter.on('error', async (error) => {
    const msg = await app.client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel: process.env.LOG_CHANNEL || 'C0P5NE354',
        text: `<!subteam^${process.env.DEV_USERGROUP}> I summon thee for the following reason: \`Hack Hour${Environment.PROD ? '' : ' (DEV)'} crashed!\`\n*Error:*\n\`\`\`${error.message}\`\`\``,
    });

    await app.client.reactions.add({
        token: process.env.SLACK_BOT_TOKEN,
        channel: msg.channel,
        name: 'eyes_shaking',
        timestamp: msg.ts
    });
});