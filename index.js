// server/notifications-server.js
require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const cors = require('cors');

// Initialize Firebase Admin
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const app = express();
const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Helper function to send and log notification
async function sendAndLogNotification(notificationData) {
  const {
    toUserId,
    type,
    title,
    body,
    senderName,
    senderAvatar,
    targetId,
    targetType,
    extraData = {}
  } = notificationData;

  try {
    // Get user's FCM token
    const userDoc = await db.collection('Users').doc(toUserId).get();
    const userData = userDoc.data();
    const fcmToken = userData?.fcmToken;

    if (!fcmToken) {
      console.warn(`No FCM token found for user ${toUserId}`);
      return false;
    }

    // Prepare FCM message
    const message = {
      token: fcmToken,
      notification: { title, body },
      data: {
        type,
        senderId: extraData.senderId || '',
        senderName,
        senderAvatar,
        targetId,
        targetType,
        placeId: extraData.placeId || '',
        reviewId: extraData.reviewId || '',
        commentId: extraData.commentId || '',
        ...extraData
      },
      android: {
        priority: 'high',
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    // Send FCM message
    await admin.messaging().send(message);
    console.log(`Notification sent to user ${toUserId}: ${title}`);

    // Save to Firestore
    const notificationDoc = {
      type,
      title,
      body,
      senderId: extraData.senderId || '',
      senderName,
      senderAvatar,
      targetId,
      targetType,
      isRead: false,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      extraData,
    };

    await db
      .collection('Users')
      .doc(toUserId)
      .collection('Notifications')
      .add(notificationDoc);

    console.log(`Notification saved to Firestore for user ${toUserId}`);
    return true;

  } catch (error) {
    console.error('Error sending notification:', error);
    
    // Handle invalid FCM tokens
    if (error.code === 'messaging/registration-token-not-registered') {
      console.warn(`Removing invalid FCM token for user ${toUserId}`);
      await db.collection('Users').doc(toUserId).update({
        fcmToken: admin.firestore.FieldValue.delete()
      });
    }
    
    return false;
  }
}

// API Endpoints

// Send notification
app.post('/send-notification', async (req, res) => {
  try {
    const notificationData = req.body;
    
    const success = await sendAndLogNotification(notificationData);
    
    if (success) {
      res.status(200).json({ message: 'Notification sent successfully' });
    } else {
      res.status(500).json({ error: 'Failed to send notification' });
    }
  } catch (error) {
    console.error('Error in /send-notification:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register FCM token
app.post('/register-token', async (req, res) => {
  try {
    const { userId, fcmToken } = req.body;

    if (!userId || !fcmToken) {
      return res.status(400).json({ error: 'Missing userId or fcmToken' });
    }

    await db.collection('Users').doc(userId).set({
      fcmToken,
      fcmTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    res.status(200).json({ message: 'FCM token registered successfully' });
  } catch (error) {
    console.error('Error registering FCM token:', error);
    res.status(500).json({ error: 'Failed to register FCM token' });
  }
});

// Firestore Listeners for Real-time Events

// Listen for new reviews
function setupNewReviewListener() {
  console.log('Setting up new review listener...');
  
  db.collection('Reviews').onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === 'added') {
        const review = change.doc.data();
        const reviewId = change.doc.id;
        
        // Notify place owner about new review
        await sendAndLogNotification({
          toUserId: review.placeOwnerId,
          type: 'new_review',
          title: 'New Review on Your Place',
          body: `${review.userName} reviewed "${review.placeName}"`,
          senderName: review.userName,
          senderAvatar: review.userAvatar,
          targetId: review.placeId,
          targetType: 'place',
          extraData: {
            senderId: review.userId,
            placeId: review.placeId,
            reviewId: reviewId,
            rating: review.rating,
            reviewText: review.reviewText,
          },
        });
      }
    });
  });
}

// Listen for review likes
function setupReviewLikeListener() {
  console.log('Setting up review like listener...');
  
  db.collection('Reviews').onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === 'modified') {
        const review = change.doc.data();
        const reviewId = change.doc.id;
        const oldReview = change.doc.previous.data();
        
        // Check if likes count increased
        const newLikes = review.likes || [];
        const oldLikes = oldReview?.likes || [];
        
        if (newLikes.length > oldLikes.length) {
          const newLikeUserId = newLikes.find(like => !oldLikes.includes(like));
          
          if (newLikeUserId && newLikeUserId !== review.userId) {
            // Get liker's info
            const likerDoc = await db.collection('Users').doc(newLikeUserId).get();
            const likerData = likerDoc.data();
            
            await sendAndLogNotification({
              toUserId: review.userId,
              type: 'review_liked',
              title: 'Your Review Got Liked',
              body: `${likerData?.name || 'Someone'} liked your review`,
              senderName: likerData?.name || 'User',
              senderAvatar: likerData?.avatar || '',
              targetId: reviewId,
              targetType: 'review',
              extraData: {
                senderId: newLikeUserId,
                placeId: review.placeId,
                reviewId: reviewId,
                likeCount: newLikes.length,
              },
            });
          }
        }
      }
    });
  });
}

// Listen for new comments
function setupNewCommentListener() {
  console.log('Setting up new comment listener...');
  
  db.collection('Comments').onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === 'added') {
        const comment = change.doc.data();
        const commentId = change.doc.id;
        
        // Notify review author about new comment
        if (comment.parentType === 'review') {
          const reviewDoc = await db.collection('Reviews').doc(comment.parentId).get();
          const review = reviewDoc.data();
          
          if (review && comment.userId !== review.userId) {
            await sendAndLogNotification({
              toUserId: review.userId,
              type: 'new_comment',
              title: 'New Comment on Your Review',
              body: `${comment.userName} commented on your review`,
              senderName: comment.userName,
              senderAvatar: comment.userAvatar,
              targetId: comment.parentId,
              targetType: 'review',
              extraData: {
                senderId: comment.userId,
                placeId: review.placeId,
                reviewId: comment.parentId,
                commentId: commentId,
              },
            });
          }
        }
        
        // Notify parent comment author about reply
        if (comment.parentCommentId) {
          const parentCommentDoc = await db.collection('Comments').doc(comment.parentCommentId).get();
          const parentComment = parentCommentDoc.data();
          
          if (parentComment && comment.userId !== parentComment.userId) {
            await sendAndLogNotification({
              toUserId: parentComment.userId,
              type: 'comment_replied',
              title: 'New Reply to Your Comment',
              body: `${comment.userName} replied to your comment`,
              senderName: comment.userName,
              senderAvatar: comment.userAvatar,
              targetId: comment.parentCommentId,
              targetType: 'comment',
              extraData: {
                senderId: comment.userId,
                placeId: comment.placeId,
                commentId: commentId,
                parentCommentId: comment.parentCommentId,
              },
            });
          }
        }
      }
    });
  });
}

// Listen for new followers
function setupNewFollowerListener() {
  console.log('Setting up new follower listener...');
  
  db.collection('Users').onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === 'modified') {
        const user = change.doc.data();
        const userId = change.doc.id;
        const oldUser = change.doc.previous.data();
        
        // Check if followers count increased
        const newFollowers = user.followers || [];
        const oldFollowers = oldUser?.followers || [];
        
        if (newFollowers.length > oldFollowers.length) {
          const newFollowerId = newFollowers.find(follower => !oldFollowers.includes(follower));
          
          if (newFollowerId) {
            // Get follower's info
            const followerDoc = await db.collection('Users').doc(newFollowerId).get();
            const followerData = followerDoc.data();
            
            await sendAndLogNotification({
              toUserId: userId,
              type: 'new_follower',
              title: 'New Follower',
              body: `${followerData?.name || 'Someone'} started following you`,
              senderName: followerData?.name || 'User',
              senderAvatar: followerData?.avatar || '',
              targetId: newFollowerId,
              targetType: 'user',
              extraData: {
                senderId: newFollowerId,
              },
            });
          }
        }
      }
    });
  });
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/ping', (req, res) => {
  res.status(200).send('Server is awake!');
});

// --- Root Endpoint ---
app.get('/', (req, res) => {
    res.send('Place Review Backend is running!');
});

// Start server
app.listen(PORT,HOST, () => {
   const serverUrl = `http://${HOST}:${PORT}`;
  console.log(`Node.js Server running on http://${HOST}:${PORT}`);
  console.log(`Access your API at: ${serverUrl}`);
  console.log(`(For Android Emulator, use: http://10.0.2.2:${PORT})`);
  console.log(`Reviews App Notification Server running on port ${PORT}`);

  // Initialize listeners
  setupNewReviewListener();
  setupReviewLikeListener();
  setupNewCommentListener();
  setupNewFollowerListener();
  
  console.log('All notification listeners initialized');
});